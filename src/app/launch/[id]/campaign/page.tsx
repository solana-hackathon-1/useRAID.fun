import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { StudioAccess } from '@/components/studio-access';
import { db } from '@/lib/db';
import { ownedLaunch } from '@/lib/meteora/launch';
import { campaignBalances } from '@/lib/meteora/campaigns';
import { MeteoraCampaignEditor, type CampaignEditorData } from '@/components/meteora-campaign-editor';
export const dynamic='force-dynamic';
export default async function CampaignPage({params}:{params:Promise<{id:string}>}) {
  const user=await currentUser();if(!user)return <StudioAccess/>;
  let launch;try{launch=await ownedLaunch((await params).id,user.id);}catch{notFound();}
  const raids=await db.raid.findMany({where:{tokenLaunchId:launch.id,fundingAsset:'LAUNCH'},include:{briefPosts:true},orderBy:{createdAt:'desc'}});
  const data:CampaignEditorData={launchId:launch.id,name:launch.name,symbol:launch.symbol,mint:launch.mint,network:launch.network as 'devnet'|'mainnet',
    balances:await campaignBalances(launch.id,launch.mint),xConnected:!!await db.xAccount.findUnique({where:{userId:user.id}}),
    raids:raids.map(r=>({id:r.id,title:r.title,description:r.description,status:r.status,impressionTarget:r.impressionTarget,
      duration:(+r.endsAt-+r.startsAt)/3600000,targetPosts:r.briefPosts.map(p=>`https://x.com/i/web/status/${p.postId}`),draftBudgets:r.launchDraft as CampaignEditorData['raids'][number]['draftBudgets']}))};
  return <MeteoraCampaignEditor data={data}/>;
}
