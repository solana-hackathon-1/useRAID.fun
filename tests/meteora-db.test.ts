import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { Keypair,SystemProgram,Transaction,type Connection } from '@solana/web3.js';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { saveLaunchCampaign,launchBalance,allocateLaunchCampaign,approveLaunchPayout } from '../src/lib/meteora/campaigns';
import { prepareStep,submitStep } from '../src/lib/meteora/transactions';
vi.mock('../src/lib/providers/x',()=>({lookupPosts:vi.fn(async(ids:string[])=>({data:ids.map(id=>({id,text:'Verified public target',author_id:'project'}))}))}));
const suite=process.env.RUN_METEORA_DB_TESTS==='true'?describe:describe.skip;
suite('Meteora PostgreSQL financial boundaries',()=>{
  let owner:Awaited<ReturnType<typeof db.user.create>>,launch:Awaited<ReturnType<typeof db.tokenLaunch.create>>;
  const payer=Keypair.generate();
  const input={title:'Fee-funded raid',targetPosts:['https://x.com/project/status/123456789'],impressionTarget:1000,duration:24,solBudget:'0.02',tokenBudget:'10',termsAccepted:true};
  beforeAll(async()=>{
    if(new URL(process.env.DATABASE_URL || 'http://invalid').pathname!=='/useraid_meteora_test')throw Error('Use dedicated useraid_meteora_test database.');
    await db.$executeRawUnsafe('TRUNCATE "User","Token","Settings","Job" CASCADE');
    vi.stubEnv('METEORA_NETWORK','devnet');vi.stubEnv('X_BEARER_TOKEN','fixture');vi.stubEnv('METEORA_PAYOUT_ENABLED','true');vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED','true');
    config.demo=false;config.liveApproved=true;
    await db.settings.create({data:{collectionEnabled:true}});
    owner=await db.user.create({data:{handle:'meteora-fixture',xId:'meteora-owner'}});
    await db.xAccount.create({data:{userId:owner.id,xUserId:owner.xId!,username:owner.handle,displayName:'Fixture'}});
    launch=await db.tokenLaunch.create({data:{userId:owner.id,provider:'METEORA',network:'devnet',name:'Test launch',symbol:'TEST',mint:Keypair.generate().publicKey.toBase58(),
      feeAddress:Keypair.generate().publicKey.toBase58(),creatorAddress:payer.publicKey.toBase58(),feeSecret:'encrypted-fixture',mintSecret:'encrypted-fixture',metadataUri:'ipfs://fixture',imageUri:'ipfs://fixture',description:'Fixture',status:'LIVE',workerObservedAt:new Date()}});
    await db.token.create({data:{mint:launch.mint,name:launch.name,symbol:launch.symbol}});
    await db.launchBalanceEntry.createMany({data:[{key:'test-sol',launchId:launch.id,network:'devnet',asset:'SOL',kind:'FEE_RECEIPT',availableDelta:30000000n,reservedDelta:0n},
      {key:'test-token',launchId:launch.id,network:'devnet',asset:launch.mint,kind:'RESERVE_RECEIPT',availableDelta:20000000n,reservedDelta:0n}]});
  });
  afterAll(async()=>{vi.unstubAllEnvs();await db.$disconnect();});
  it('concurrent starts cannot overspend; receipts do not change fixed budgets',async()=>{
    const draftA=await saveLaunchCampaign(launch.id,owner.id,input),draftB=await saveLaunchCampaign(launch.id,owner.id,{...input,title:'Second raid'});
    const outcomes=await Promise.allSettled([saveLaunchCampaign(launch.id,owner.id,{...input,raidId:draftA.id},true),saveLaunchCampaign(launch.id,owner.id,{...input,raidId:draftB.id},true)]);
    expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);
    expect(await launchBalance(launch.id,'SOL')).toEqual({available:10000000n,reserved:20000000n});
    const active=await db.raid.findFirstOrThrow({where:{tokenLaunchId:launch.id,status:'ACTIVE'}});
    await db.launchBalanceEntry.create({data:{key:'new-fees',launchId:launch.id,network:'devnet',asset:'SOL',kind:'FEE_RECEIPT',availableDelta:50000000n,reservedDelta:0n}});
    expect((await db.launchCampaignBudget.findUniqueOrThrow({where:{raidId_asset:{raidId:active.id,asset:'SOL'}}})).reservedUnits).toBe(20000000n);
    await expect(db.launchBalanceEntry.update({where:{key:'new-fees'},data:{availableDelta:0n}})).rejects.toThrow('append-only');
    await expect(db.tokenLaunch.update({where:{id:launch.id},data:{feeAddress:Keypair.generate().publicKey.toBase58()}})).rejects.toThrow('immutable');
  });
  it('settles dual assets exactly once, leaves new fees available, freezes approval identity',async()=>{
    const raid=await db.raid.findFirstOrThrow({where:{tokenLaunchId:launch.id,status:'ACTIVE'}}),wallet=Keypair.generate().publicKey.toBase58();
    const result=await db.campaignResult.create({data:{raidId:raid.id,version:1,fingerprint:'meteora-partial',payload:{participants:[{enrollmentId:'member',userId:owner.id,xId:'raider',walletAddress:wallet}],
      contributions:[{id:'post',enrollmentId:'member',authorId:'raider',views:500,qualification:'QUALIFIED',availability:'AVAILABLE',reviewStatus:'CLEAR',hidden:false,deleted:false}]}}});
    await db.raid.update({where:{id:raid.id},data:{status:'ENDED',trackingPhase:'APPROVED',activeResultId:result.id}});
    await Promise.all([allocateLaunchCampaign(raid.id),allocateLaunchCampaign(raid.id)]);
    expect(await db.launchCampaignPayout.count({where:{raidId:raid.id}})).toBe(2);
    expect(await launchBalance(launch.id,'SOL')).toEqual({available:70000000n,reserved:10000000n});
    const p=await db.launchCampaignPayout.findFirstOrThrow({where:{raidId:raid.id,asset:'SOL'}});
    await approveLaunchPayout(p.id,owner.id,true);
    await expect(approveLaunchPayout(p.id,owner.id,false,'late hold')).rejects.toMatchObject({status:409});
    await expect(db.launchCampaignPayout.update({where:{id:p.id},data:{units:1n}})).rejects.toThrow('immutable');
    await expect(db.launchCampaignBudget.update({where:{raidId_asset:{raidId:raid.id,asset:'SOL'}},data:{reservedUnits:1n}})).rejects.toThrow('immutable');
  });
  it('missing views hold settlement; zero impressions return full budget with no payout',async()=>{
    const draft=await saveLaunchCampaign(launch.id,owner.id,{...input,tokenBudget:'0'});
    await saveLaunchCampaign(launch.id,owner.id,{...input,raidId:draft.id,tokenBudget:'0'},true);
    let result=await db.campaignResult.create({data:{raidId:draft.id,version:1,fingerprint:'unknown',payload:{participants:[],contributions:[{id:'unknown',views:null,qualification:'QUALIFIED',availability:'AVAILABLE',reviewStatus:'CLEAR',hidden:false,deleted:false}]}}});
    await db.raid.update({where:{id:draft.id},data:{status:'ENDED',trackingPhase:'APPROVED',activeResultId:result.id}});await allocateLaunchCampaign(draft.id);
    expect((await db.launchCampaignBudget.findUniqueOrThrow({where:{raidId_asset:{raidId:draft.id,asset:'SOL'}}})).status).toBe('RESERVED');
    result=await db.campaignResult.create({data:{raidId:draft.id,version:2,fingerprint:'zero',payload:{participants:[],contributions:[]}}});
    await db.raid.update({where:{id:draft.id},data:{activeResultId:result.id}});await allocateLaunchCampaign(draft.id);
    expect(await db.launchCampaignPayout.count({where:{raidId:draft.id}})).toBe(0);
    expect((await db.launchCampaignBudget.findUniqueOrThrow({where:{raidId_asset:{raidId:draft.id,asset:'SOL'}}})).earnedUnits).toBe(0n);
    expect(await launchBalance(launch.id,'SOL')).toEqual({available:70000000n,reserved:10000000n});
  });
  it('rejected/expired quote and simultaneous prepare/submit preserve one signed message',async()=>{
    const blockhash=Keypair.generate().publicKey.toBase58();let sends=0;
    const rpc={getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100}),getBlockHeight:async()=>1,getSignatureStatuses:async()=>({value:[null]}),sendRawTransaction:async()=>{sends++;return 'signature';}} as unknown as Connection;
    const build=()=>new Transaction().add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1n}));
    const step=await prepareStep(rpc,launch.id,'race','PAYOUT','Payout',payer.publicKey,build());
    const signed=Transaction.from(Buffer.from(step.transaction!,'base64'));signed.sign(payer);
    await Promise.all([submitStep(rpc,step.id,signed.serialize().toString('base64'),payer.publicKey.toBase58()),prepareStep(rpc,launch.id,'race','PAYOUT','Payout',payer.publicKey,build())]);
    const after=await db.launchStep.findUniqueOrThrow({where:{id:step.id}});expect(after.status).toBe('SUBMITTED');expect(after.signature).toBeTruthy();expect(after.messageHash).toBe(step.messageHash);expect(sends).toBe(1);
    await prepareStep(rpc,launch.id,'race','PAYOUT','Payout',payer.publicKey,build());expect((await db.launchStep.findUniqueOrThrow({where:{id:step.id}})).status).toBe('SUBMITTED');
    const expired=await prepareStep(rpc,launch.id,'expired','TRADE','Buy',payer.publicKey,build());await db.launchStep.update({where:{id:expired.id},data:{expiresAt:new Date(Date.now()-1000)}});
    const expiredTx=Transaction.from(Buffer.from(expired.transaction!,'base64'));expiredTx.sign(payer);await expect(submitStep(rpc,expired.id,expiredTx.serialize().toString('base64'),payer.publicKey.toBase58())).rejects.toMatchObject({status:409});expect(sends).toBe(1);
  });
});
