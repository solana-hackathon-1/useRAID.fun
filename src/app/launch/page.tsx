import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { meteoraReadiness } from '@/lib/meteora/config';
import { MeteoraLaunchWizard } from '@/components/meteora-launch-wizard';
export const dynamic = 'force-dynamic';
export default async function LaunchPage() {
  const user = await currentUser(), readiness = meteoraReadiness();
  const wallet = user ? await db.walletIdentity.findUnique({ where: { userId: user.id } }) : null;
  const recoveries = user ? await db.tokenLaunch.findMany({ where: { userId: user.id, provider: 'METEORA', network: readiness.network,
    status: { in: ['PREPARED','SUBMITTED','LIVE','PAUSED'] } }, select: { id:true,name:true,symbol:true,status:true,mint:true }, orderBy: { createdAt:'desc' }, take:20 }) : [];
  return <MeteoraLaunchWizard readiness={readiness} walletAddress={wallet?.address || null} signedIn={!!user} recoveries={recoveries} />;
}
