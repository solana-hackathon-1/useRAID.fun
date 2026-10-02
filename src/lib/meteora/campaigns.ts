import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { config, trackingEnabled, trackingSettlementEnabled } from '../config';
import { HttpError } from '../auth-primitives';
import { targetIds, targetPreviews } from '../studio-targets';
import { lockTracking } from '../tracking';
import { trackingBlockers, type ResultPayload } from '../tracking-review';
import { splitImpressionFunding } from '../raid-allocation';
import { ownedLaunch } from './launch';
import { launchTemplate, parseUnits, SOL_ASSET } from './amounts';
import { meteoraNetwork } from './config';
export async function lockLaunchBalance(tx:Prisma.TransactionClient,id:string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`meteora-balance:${id}`}))`;
}
export async function launchBalance(launchId:string,asset:string,tx:Prisma.TransactionClient|typeof db=db) {
  const sum=await tx.launchBalanceEntry.aggregate({where:{launchId,asset,network:meteoraNetwork()},_sum:{availableDelta:true,reservedDelta:true}});
  return {available:sum._sum.availableDelta||0n,reserved:sum._sum.reservedDelta||0n};
}
export async function campaignBalances(launchId:string,mint:string) {
  const [sol,token,paid]=await Promise.all([launchBalance(launchId,SOL_ASSET),launchBalance(launchId,mint),
    db.launchCampaignPayout.groupBy({by:['asset'],where:{launchId,status:'PAID'},_sum:{units:true}})]);
  return {sol:{available:sol.available.toString(),reserved:sol.reserved.toString(),paid:(paid.find(p=>p.asset===SOL_ASSET)?._sum.units||0n).toString()},
    token:{available:token.available.toString(),reserved:token.reserved.toString(),paid:(paid.find(p=>p.asset===mint)?._sum.units||0n).toString()}};
}
const campaignInput=z.object({raidId:z.string().optional(),title:z.string().trim().min(3).max(120),
  description:z.string().max(2000).default(''),targetPosts:z.array(z.string().max(300)).min(1).max(100),
  impressionTarget:z.number().int().min(1000).max(1_000_000_000),duration:z.number().refine(n=>[6,12,24,72,168].includes(n),'Choose an available duration.'),
  solBudget:z.string(),tokenBudget:z.string().default('0'),termsAccepted:z.boolean().default(false)});
export async function saveLaunchCampaign(launchId:string,userId:string,input:unknown,start=false) {
  const launch=await ownedLaunch(launchId,userId),data=campaignInput.parse(input);
  if (launch.status!=='LIVE') throw new HttpError(409,'Token must be live before setting up raid.');
  if (!await db.xAccount.findUnique({where:{userId}})) throw new HttpError(403,'Connect X to set up your raid.');
  const ids=targetIds(data.targetPosts),previews=await targetPreviews(ids,data.raidId);
  if (previews.length!==ids.length) throw new HttpError(409,'Every target post must be public and available.');
  let sol:bigint,tokens:bigint;
  try { sol=parseUnits(data.solBudget,9); tokens=data.tokenBudget==='0'?0n:parseUnits(data.tokenBudget,6); } catch(e) {throw new HttpError(400,(e as Error).message);}
  if (sol<parseUnits(launchTemplate(launch.network as 'mainnet'|'devnet').minimumCampaignSol,9)) throw new HttpError(400,'SOL budget is below minimum raid budget.');
  if (start&&!data.termsAccepted) throw new HttpError(400,'Accept reward and unused-budget terms.');
  return db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(729103)`;
    await lockLaunchBalance(tx,launchId);
    const current=await tx.tokenLaunch.findUniqueOrThrow({where:{id:launchId},include:{user:true}});
    if (current.user.suspended||current.status!=='LIVE') throw new HttpError(409,'Launch is unavailable.');
    const now=new Date();
    const existing=data.raidId?await tx.raid.findUnique({where:{id:data.raidId}}):null;
    if (data.raidId&&(!existing||existing.hidden||existing.creatorId!==userId||existing.tokenLaunchId!==launchId||existing.fundingAsset!=='LAUNCH'||existing.status!=='DRAFT')) throw new HttpError(409,'Only your draft raid can be edited.');
    const fields={title:data.title,description:data.description,impressionTarget:data.impressionTarget,startsAt:now,endsAt:new Date(+now+data.duration*3600000),launchDraft:{solBudget:data.solBudget,tokenBudget:data.tokenBudget}};
    const raid=existing?await tx.raid.update({where:{id:existing.id},data:fields}):await tx.raid.create({data:{...fields,
      creatorId:userId,tokenLaunchId:launchId,mint:launch.mint,projectName:launch.name,projectSymbol:launch.symbol,imageUri:launch.imageUri,
      tag:`raid_${randomBytes(5).toString('hex')}`,fundingAsset:'LAUNCH',fundingNetwork:launch.network,fundingStatus:'PENDING',
      trackingVersion:2,ruleVersion:4,scoringVersion:2,officialHandle:config.handle}});
    await lockTracking(tx,raid.id);
    await tx.raidBriefPost.deleteMany({where:{raidId:raid.id,postId:{notIn:ids}}});
    for(const preview of previews) await tx.raidBriefPost.upsert({where:{raidId_postId:{raidId:raid.id,postId:preview.id}},
      create:{raidId:raid.id,postId:preview.id,preview,validatedAt:now},update:{preview,validatedAt:now}});
    if(start) {
      const settings=await tx.settings.findUnique({where:{id:'global'}});
      if(!trackingEnabled()||!trackingSettlementEnabled()||!config.liveApproved||!process.env.X_BEARER_TOKEN||!settings?.collectionEnabled||settings.payoutPaused ||
          process.env.METEORA_PAYOUT_ENABLED !== 'true' || !current.workerObservedAt || Date.now()-+current.workerObservedAt>120000)
        throw new HttpError(503,'X collection and reward settlement must be ready before starting a raid.');
      if(await tx.raid.count({where:{status:{in:['ACTIVE','SCHEDULED']},hidden:false,endsAt:{gt:now}}})>=settings.maxActiveRaids)
        throw new HttpError(409,'Active raid capacity reached.');
      for(const [asset,units] of [[SOL_ASSET,sol],[launch.mint,tokens]] as const) {
        if(!units)continue;
        if((await launchBalance(launchId,asset,tx)).available<units) throw new HttpError(409,`Insufficient ${asset===SOL_ASSET?'SOL':'token'} campaign balance.`);
        await tx.launchCampaignBudget.create({data:{launchId,raidId:raid.id,network:launch.network,asset,reservedUnits:units}});
        await tx.launchBalanceEntry.create({data:{key:`reserve:${raid.id}:${asset}`,launchId,raidId:raid.id,network:launch.network,asset,
          kind:'RESERVED',availableDelta:-units,reservedDelta:units}});
      }
      await tx.raid.update({where:{id:raid.id},data:{status:'ACTIVE',fundingStatus:'VERIFIED',fundingRecipient:launch.feeAddress,
        fundedAt:now,poolUnits:sol,fundingLamports:sol.toString()}});
    }
    await tx.tokenLaunch.update({where:{id:launchId},data:{raidId:raid.id}});
    return {id:raid.id,status:start?'ACTIVE':'DRAFT'};
  },{timeout:30000});
}
export async function allocateLaunchCampaign(raidId:string) {
  return db.$transaction(async tx=>{
    await lockTracking(tx,raidId);
    const raid=await tx.raid.findUniqueOrThrow({where:{id:raidId},include:{creator:true}});
    if(raid.fundingAsset!=='LAUNCH'||!raid.tokenLaunchId||raid.fundingNetwork!==meteoraNetwork()||raid.trackingPhase!=='APPROVED'||
      raid.hidden||raid.creator.suspended||raid.fundingStatus!=='VERIFIED'||!raid.activeResultId||!raid.impressionTarget)return;
    if(await trackingBlockers(tx,raidId))return;
    await lockLaunchBalance(tx,raid.tokenLaunchId);
    const budgets=await tx.launchCampaignBudget.findMany({where:{raidId,status:'RESERVED'}});
    if(!budgets.length)return;
    const result=await tx.campaignResult.findUniqueOrThrow({where:{id:raid.activeResultId}});
    const payload=result.payload as unknown as ResultPayload;
    const posts=payload.contributions.filter(p=>p.qualification==='QUALIFIED'&&p.availability==='AVAILABLE'&&p.reviewStatus!=='FLAGGED'&&!p.hidden&&!p.deleted);
    if(posts.some(p=>p.views==null||!Number.isSafeInteger(p.views)||p.views<0))return;
    const shares=payload.participants.map(p=>({xId:p.xId,walletAddress:p.walletAddress,
      views:posts.filter(post=>post.enrollmentId===p.enrollmentId).reduce((a,p)=>a+(p.views||0),0)}));
    if(shares.some(p=>!Number.isSafeInteger(p.views)))return;
    for(const budget of budgets) {
      const amounts=splitImpressionFunding(budget.reservedUnits,raid.impressionTarget,shares);
      for(const reward of amounts.rewards) await tx.launchCampaignPayout.create({data:{launchId:budget.launchId,raidId,asset:budget.asset,
        network:budget.network,xId:reward.xId,walletAddress:reward.walletAddress,units:reward.lamports}});
      await tx.launchBalanceEntry.create({data:{key:`settle:${raidId}:${budget.asset}`,launchId:budget.launchId,network:budget.network,asset:budget.asset,
        kind:'SETTLED',raidId,availableDelta:amounts.refund,reservedDelta:-amounts.refund}});
      await tx.launchCampaignBudget.update({where:{id:budget.id},data:{status:'ALLOCATED',resultId:result.id,earnedUnits:budget.reservedUnits-amounts.refund}});
    }
    await tx.raid.update({where:{id:raidId},data:{trackingPhase:'ALLOCATED'}});
  },{timeout:30000});
}
export async function approveLaunchPayout(id:string,actorId:string,approve:boolean,reason='') {
  if(!approve&&!reason.trim())throw new HttpError(400,'Provide reason for holding payout.');
  return db.$transaction(async tx=>{
    const payout=await tx.launchCampaignPayout.findUniqueOrThrow({where:{id}});
    await lockLaunchBalance(tx,payout.launchId);
    const current=await tx.launchCampaignPayout.findUniqueOrThrow({where:{id}});
    if(current.network!==meteoraNetwork()||!['PENDING','HELD'].includes(current.status))throw new HttpError(409,'Payout cannot be changed.');
    await tx.launchCampaignPayout.update({where:{id},data:{status:approve?'APPROVED':'HELD',approvedBy:actorId,approvedAt:approve?new Date():null}});
    await tx.moderationEvent.create({data:{actorId,action:approve?'meteora-payout-approved':'meteora-payout-held',targetId:id,reason:reason||'Reviewed immutable allocation'}});
  });
}
