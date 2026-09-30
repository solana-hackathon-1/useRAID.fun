import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { StudioAccess } from '@/components/studio-access';
import { StudioBalance } from '@/components/studio-balance';
import { balanceView, usdcSettings, studioSandbox, depositsReady } from '@/lib/usdc';
export const dynamic = 'force-dynamic';
export default async function BalancePage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const user = await currentUser();
  if (!user) return <StudioAccess />;
  const [view, wallet] = await Promise.all([
    balanceView(user.id),
    db.walletIdentity.findUnique({ where: { userId: user.id } }),
  ]);
  const { returnTo } = await searchParams,
    settings = usdcSettings();
  return (
    <StudioBalance
      view={view}
      walletAddress={wallet?.address || null}
      ready={settings.ready}
      depositReady={await depositsReady()}
      network={settings.network}
      sandbox={studioSandbox()}
      returnTo={returnTo?.startsWith('/creator/') ? returnTo : null}
    />
  );
}
