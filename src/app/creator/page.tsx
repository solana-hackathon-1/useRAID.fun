import Link from 'next/link';
import { CampaignStatus } from '@/components/ui';
import { XConnection } from '@/components/x-connection';
import { XDiagnostics } from '@/components/x-diagnostics';
import { currentUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { db } from '@/lib/db';
import { CreatorForm, AffiliationForm } from '@/components/creator-form';
import { MutationButton } from '@/components/actions';
export const dynamic = 'force-dynamic';
export default async function CreatorPage({
  searchParams,
}: {
  searchParams: Promise<{ auth?: string }>;
}) {
  const user = await currentUser();
  const { auth } = await searchParams;
  if (!user)
    return (
      <section className="panel access-card">
        <span className="status-pill">Invited creator pilot</span>
        <h1 style={{ marginTop: 22 }}>
          Give your community
          <br />a place to show up.
        </h1>
        <p>
          Launch a campaign, invite original posts on X, and follow the attention as it develops.
          The pilot is open to approved project creators.
        </p>
        <XConnection status={auth} demo={config.demo} />
        {process.env.NODE_ENV === 'development' && <XDiagnostics />}
        <p className="small-print">
          We request read-only identity access. useRAID does not publish posts on your behalf.
        </p>
        <Link href="/" className="inline-link">
          Explore campaigns
        </Link>
        <Link href="/launch" className="inline-link" style={{ marginLeft: 16 }}>
          Launch a token
        </Link>
      </section>
    );
  const account = await db.xAccount.findUnique({ where: { userId: user.id } });
  const raids = await db.raid.findMany({
    where: { creatorId: user.id },
    orderBy: { createdAt: 'desc' },
    include: { token: true },
  });
  return (
    <>
      <div className="page-title">
        <h1>Creator studio</h1>
        <p>
          Signed in as @{user.handle}.{' '}
          {user.approved ? 'Your next conversation starts here.' : 'Creator approval is pending.'}
        </p>
      </div>
      <div className="form-actions">
        <Link className="button secondary" href="/launch">
          Launch token on pump.fun
        </Link>
      </div>
      <XConnection account={account} status={auth} />
      {process.env.NODE_ENV === 'development' && <XDiagnostics userId={user.id} />}
      {!user.approved ? (
        <section className="panel">
          <h2>Tell us about your project</h2>
          <AffiliationForm initial={user.affiliation} />
        </section>
      ) : (
        <div className="creator-layout">
          <section className="panel">
            <h2>Create a campaign</h2>
            <CreatorForm />
          </section>
          <section className="panel">
            <h2>Your campaigns</h2>
            {!raids.length && <p>Your saved drafts and launched campaigns will appear here.</p>}
            {raids.map((r) => (
              <article className="campaign-manage" key={r.id}>
                <strong>{r.title}</strong>
                <p>
                  {r.token.symbol} · <CampaignStatus status={r.status} />{' '}
                  {r.hidden ? '· hidden by moderation' : ''}
                </p>
                <div className="form-actions">
                  {r.status === 'DRAFT' && (
                    <MutationButton
                      url={`/api/raids/${r.id}`}
                      body={{ action: 'launch' }}
                      secondary={false}
                    >
                      Launch / schedule
                    </MutationButton>
                  )}
                  {['ACTIVE', 'SCHEDULED'].includes(r.status) && (
                    <MutationButton url={`/api/raids/${r.id}`} body={{ action: 'end' }}>
                      End campaign
                    </MutationButton>
                  )}
                  {['ACTIVE', 'ENDED'].includes(r.status) && (
                    <Link className="inline-link" href={`/raids/${r.id}`}>
                      View raid
                    </Link>
                  )}
                </div>
              </article>
            ))}
          </section>
        </div>
      )}
      <div className="form-actions">
        {user.role === 'ADMIN' && (
          <Link className="button secondary" href="/admin">
            Open admin
          </Link>
        )}
        <MutationButton url="/api/auth/logout" body={{}}>
          Sign out
        </MutationButton>
      </div>
    </>
  );
}
