import { LaunchWizard } from '@/components/launch-wizard';
import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { launchEnabled } from '@/lib/pump-launch';
export const dynamic = 'force-dynamic';
export default async function LaunchPage() {
  const user = await currentUser();
  const wallet = user ? await db.walletIdentity.findUnique({ where: { userId: user.id } }) : null;
  const settings = launchEnabled()
    ? await db.settings.findUnique({ where: { id: 'global' } })
    : null;
  const recoveries = user
    ? await db.tokenLaunch.findMany({
        where: { userId: user.id, status: { in: ['PREPARED', 'SUBMITTED'] } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, name: true, symbol: true, status: true },
      })
    : [];
  const enabled =
    launchEnabled() &&
    !!settings?.collectionEnabled &&
    !settings.launchPaused &&
    !settings.payoutPaused &&
    !!settings.payoutWorkerAt &&
    +settings.payoutWorkerAt > Date.now() - 120000 &&
    settings.operatorAddress === process.env.OPERATOR_PUBLIC_KEY;
  return (
    <>
      <div className="page-title">
        <h1>Launch a token</h1>
        <p>SOL-paired pump.fun launch. Creator fees fund raider rewards.</p>
      </div>
      <LaunchWizard
        sessionWallet={wallet?.address || null}
        enabled={enabled}
        recoveries={recoveries}
      />
    </>
  );
}
