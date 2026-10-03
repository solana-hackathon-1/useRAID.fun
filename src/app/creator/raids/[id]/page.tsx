import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { currentUser } from '@/lib/auth';
import { StudioAccess } from '@/components/studio-access';
import { CreatorRaidTools, RaidShare } from '@/components/raid-tools';
import { MutationButton } from '@/components/actions';
import { formatUsdc, studioSandbox } from '@/lib/usdc';
import { SandboxControls } from '@/components/studio-sandbox';
import { trackingView } from '@/lib/tracking-view';
import { TrackingPanel } from '@/components/tracking-panel';
import { TargetPosts } from '@/components/target-posts';
import { AutoRefresh } from '@/components/refresh';
export const dynamic = 'force-dynamic';
export default async function ManageRaid({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return <StudioAccess />;
  const raid = await db.raid.findUnique({
    where: { id: (await params).id },
    include: { briefPosts: { orderBy: { createdAt: 'asc' } } },
  });
  if (!raid || raid.creatorId !== user.id) notFound();
  const view = await trackingView(raid.id, user.id),
    wallet = await db.walletIdentity.findUnique({ where: { userId: user.id } }),
    account = await db.xAccount.findUnique({ where: { userId: user.id } });
  return (
    <div className="studio">
      <AutoRefresh />
      <Link className="studio-back" href="/creator">
        ← Creator Studio
      </Link>
      <header className="studio-heading">
        <div>
          <span className={`studio-status ${raid.status === 'ACTIVE' ? 'live' : ''}`}>
            {raid.status === 'ACTIVE' ? 'Live' : raid.status === 'DRAFT' ? 'Draft' : 'Ended'}
          </span>
          <h1>{raid.title}</h1>
          <p>
            {raid.poolUnits !== null
              ? `${formatUsdc(raid.poolUnits)} USDC reward pool`
              : 'Legacy SOL campaign'}
            {raid.hidden ? ' · Hidden by moderation' : ''}
          </p>
        </div>
        {raid.status === 'DRAFT' && raid.studioVersion === 1 && (
          <Link className="button" href={`/creator/new?draft=${raid.id}`}>
            Continue draft
          </Link>
        )}
      </header>
      {raid.studioVersion === 1 && view && (
        <section className="studio-section studio-campaign-progress">
          <h2>Impression progress</h2>
          <strong>
            {view.impressions.total.toLocaleString()}{' '}
            <small>/ {raid.impressionTarget?.toLocaleString()}</small>
          </strong>
          <progress
            max={raid.impressionTarget || 1}
            value={Math.min(view.impressions.total, raid.impressionTarget || 1)}
          />
          <p>
            {raid.status === 'ACTIVE'
              ? `Ends ${raid.endsAt.toLocaleString('en')}`
              : raid.targetReachedAt
                ? 'Target reached. Results and payments follow review.'
                : 'Campaign ended.'}
          </p>
        </section>
      )}
      {raid.status !== 'DRAFT' && (
        <>
          <RaidShare id={raid.id} demo={false} />
          <Link href={`/raids/${raid.id}`} className="inline-link">
            View public Raid
          </Link>
        </>
      )}
      {studioSandbox() && raid.status === 'ACTIVE' && <SandboxControls raidId={raid.id} />}
      <TargetPosts
        posts={raid.briefPosts.map((p) => ({ id: p.postId, preview: p.preview }))}
        handle={raid.officialHandle}
        active={raid.status === 'ACTIVE'}
      />
      <section className="studio-section">
        <CreatorRaidTools
          id={raid.id}
          canEdit={['DRAFT', 'ACTIVE', 'SCHEDULED'].includes(raid.status)}
          funding={{
            required: raid.studioVersion !== 1 && !raid.mint,
            verified: raid.fundingStatus === 'VERIFIED',
            lamports: raid.fundingLamports,
            recipient: raid.fundingRecipient,
            target: raid.impressionTarget,
          }}
        />
        {raid.status === 'DRAFT' &&
          raid.studioVersion !== 1 &&
          (raid.mint || raid.fundingStatus === 'VERIFIED') && (
            <MutationButton url={`/api/raids/${raid.id}`} body={{ action: 'launch' }}>
              Launch / schedule
            </MutationButton>
          )}
        {['ACTIVE', 'SCHEDULED'].includes(raid.status) && (
          <details className="studio-end-control">
            <summary>End Raid early</summary>
            <p>
              Posting closes now. If raiders have already posted, their posts keep earning until the
              scheduled end ({raid.endsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC);
              results then enter review and unearned USDC returns to your balance. Funds stay
              reserved until then.
            </p>
            <MutationButton url={`/api/raids/${raid.id}`} body={{ action: 'end' }}>
              End campaign
            </MutationButton>
          </details>
        )}
      </section>
      {view && (
        <TrackingPanel
          raidId={raid.id}
          view={view}
          walletAddress={wallet?.address || null}
          xConnected={!!account}
        />
      )}
    </div>
  );
}
