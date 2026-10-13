import Link from 'next/link';
import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { StudioAccess } from '@/components/studio-access';
import { XConnection } from '@/components/x-connection';
import { WalletLogin } from '@/components/wallet-login';
export const dynamic = 'force-dynamic';
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; auth?: string }>;
}) {
  const user = await currentUser();
  if (!user) return <StudioAccess />;
  const [account, wallet] = await Promise.all([
    db.xAccount.findUnique({ where: { userId: user.id } }),
    db.walletIdentity.findUnique({ where: { userId: user.id } }),
  ]);
  const { returnTo, auth } = await searchParams;
  return (
    <div className="studio">
      <Link className="studio-back" href="/creator">
        ← Creator Studio
      </Link>
      <header className="studio-heading">
        <div>
          <h1>Account</h1>
          <p>Identity for campaigns and rewards.</p>
        </div>
        {returnTo?.startsWith('/creator/') && (
          <Link className="button secondary" href={returnTo}>
            Return to draft
          </Link>
        )}
      </header>
      <section className="studio-section">
        <XConnection account={account} status={auth} returnTo="account" />
      </section>
      <section className="studio-section">
        <h2>Guild draft</h2>
        <p>Prepare private project details and keep your saved draft URL.</p>
        <Link className="inline-link" href="/creator/guild-drafts/new">
          Create a private Guild draft
        </Link>
        <p>
          <Link className="inline-link" href="/creator/guild-drafts">
            My private drafts
          </Link>
        </p>
      </section>
      <section className="studio-section">
        <h2>Work preferences</h2>
        <p>Learn Raider commitments and manage your private work interests.</p>
        <Link className="inline-link" href="/raider/onboarding">
          Raider orientation
        </Link>
      </section>
      <section className="studio-section">
        <h2>Solana wallet</h2>
        <WalletLogin currentAddress={wallet?.address || null} canChange={!!account} />
      </section>
    </div>
  );
}
