import { trackingView } from '@/lib/tracking-view';
import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { TrackingPanel } from '@/components/tracking-panel';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { getRaid } from '@/lib/data';
import { config } from '@/lib/config';
import { composeUrl } from '@/lib/domain';
import {
  TokenIcon,
  Freshness,
  AttentionChart,
  CampaignStatus,
  compact,
  Empty,
} from '@/components/ui';
import { AutoRefresh } from '@/components/refresh';
import { ExternalActions, SubmitPost } from '@/components/actions';
import { MarketPanel } from '@/components/market';
import { RaidShare } from '@/components/raid-tools';
import { TargetPosts } from '@/components/target-posts';
import { formatUsdc } from '@/lib/usdc-amount';
import { oauthMessage } from '@/lib/oauth-messages';
import { formatNumber, formatUtcDateTime } from '@/lib/format';
export const dynamic = 'force-dynamic';
export default async function RaidPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ auth?: string }>;
}) {
  const raid = await getRaid((await params).id);
  const authMessage = oauthMessage((await searchParams).auth);
  if (!raid) notFound();
  const user = raid.trackingVersion === 2 ? await currentUser() : null;
  const tracking = raid.trackingVersion === 2 ? await trackingView(raid.id, user?.id) : null;
  const wallet = user ? await db.walletIdentity.findUnique({ where: { userId: user.id } }) : null;
  const account = user ? await db.xAccount.findUnique({ where: { userId: user.id } }) : null;
  const briefPosts = config.demo
    ? []
    : await db.raidBriefPost.findMany({
        where: { raidId: raid.id },
        orderBy: { createdAt: 'asc' },
      });
  return (
    <>
      <AutoRefresh
        active={
          raid.status === 'ACTIVE' ||
          (!!tracking && !['ALLOCATED', 'HELD_RESOLVED'].includes(tracking.phase))
        }
      />
      {authMessage && (
        <p role="status" className="notice">
          {authMessage}
        </p>
      )}
      <RaidShare id={raid.id} demo={config.demo} />
      <div className="breadcrumb">
        <Link href="/">
          <ArrowLeft size={13} style={{ display: 'inline' }} /> Discovery
        </Link>
        <span>/</span>
        <span>{raid.title}</span>
      </div>
      <div className="detail-header">
        <div className="detail-title">
          <TokenIcon symbol={raid.symbol} imageUri={raid.imageUri} large />
          <div>
            <h1>
              {raid.mint ? raid.symbol : raid.title}
              <span className="muted"> / raid</span>
            </h1>
            <p>
              {raid.name} ·{' '}
              {raid.mint ? (
                <Link className="inline-link" href={`/tokens/${raid.mint}`}>
                  View token profile
                </Link>
              ) : (
                <span>Independent project</span>
              )}
            </p>
          </div>
        </div>
        <ExternalActions
          demo={config.demo}
          raidId={raid.id}
          compose={composeUrl(
            tracking?.officialHandle || config.handle,
            raid.tag,
            tracking?.ruleVersion,
            briefPosts[0]?.postId,
          )}
          active={raid.status === 'ACTIVE'}
        />
      </div>
      {config.demo && (
        <div className="notice info">
          This is an example campaign. Posting and trading are disabled in this preview.
        </div>
      )}
      <div className="detail-grid">
        <div>
          <section className="panel">
            <div className="status-row">
              <CampaignStatus status={raid.status} demo={config.demo} />
              <Freshness raid={raid} />
            </div>
            <h2 className="campaign-heading">{raid.title}</h2>
            <p className="campaign-copy">{raid.description}</p>
            {(tracking?.currency === 'USDC' || tracking?.currency === 'LAUNCH') && (
              <>
                <p>
                  {tracking.poolUnits ? tracking.currency === 'USDC' ? formatUsdc(tracking.poolUnits) : (Number(tracking.poolUnits)/1e9).toFixed(4) : '—'} {tracking.currency === 'LAUNCH' ? 'SOL + optional token' : 'USDC'} reward pool ·
                  Ends at target or duration
                </p>
                <TargetPosts
                  posts={briefPosts.map((p) => ({ id: p.postId, preview: p.preview }))}
                  handle={tracking.officialHandle}
                  active={raid.status === 'ACTIVE'}
                />
              </>
            )}
            {tracking?.currency !== 'USDC' && tracking?.currency !== 'LAUNCH' && briefPosts.length > 0 && (
              <div>
                <h3>Campaign posts</h3>
                <p>Use these posts as context for your original contributions.</p>
                {briefPosts.map((post) => (
                  <p key={post.id}>
                    <a
                      className="inline-link"
                      href={`https://x.com/i/web/status/${post.postId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View campaign post
                    </a>
                  </p>
                ))}
              </div>
            )}
            <p className="small-print">
              {raid.status === 'ACTIVE' ? 'Ends' : 'Ended'} {formatUtcDateTime(raid.endsAt)}
            </p>
            <div className="metric-grid">
              <div>
                <span>Attention score</span>
                <strong>{raid.freshness === 'unavailable' ? '—' : formatNumber(raid.score)}</strong>
              </div>
              <div>
                <span>Unique raiders</span>
                <strong>{raid.freshness === 'unavailable' ? '—' : compact(raid.raiders)}</strong>
              </div>
              <div>
                <span>Raid posts</span>
                <strong>{raid.freshness === 'unavailable' ? '—' : compact(raid.posts)}</strong>
              </div>
              <div>
                <span>Observed interactions</span>
                <strong>
                  {raid.freshness === 'unavailable' ? '—' : compact(raid.interactions)}
                </strong>
              </div>
            </div>
            <div className="chart-panel">
              <AttentionChart history={raid.history} />
            </div>
            <div className="chart-note">
              <span>Recent attention score</span>
              <span>
                {raid.momentum === null
                  ? 'Building baseline'
                  : `${raid.momentum > 0 ? '+' : ''}${raid.momentum}% vs. one hour ago`}
              </span>
            </div>
            <p className="small-print">
              Experimental score v{raid.trackingVersion === 2 ? '2' : '1'} measures attributed
              activity. It does not assess project quality or predict price.{' '}
              <Link className="inline-link" href="/methodology">
                See the formula.
              </Link>
            </p>
          </section>
          {tracking && (
            <TrackingPanel
              raidId={raid.id}
              view={tracking}
              walletAddress={wallet?.address || null}
              xConnected={!!account}
            />
          )}
          <section className="panel">
            <h2>Join the conversation</h2>
            <div className="instruction">
              <p>
                Write an original post on X. Include{' '}
                <code>@{tracking?.officialHandle || config.handle}</code>
                {tracking?.ruleVersion && tracking.ruleVersion >= 3 ? (
                  <>
                    {' '}
                    after joining. If you joined overlapping Raids, submit your post URL here to
                    choose one.
                  </>
                ) : (
                  <>
                    {' '}
                    and <code>#{raid.tag}</code> during the campaign. Posts with multiple raid tags
                    won’t count.
                  </>
                )}
              </p>
            </div>
            {raid.activity.map((p) => (
              <article className="post" key={p.id}>
                <div className="post-author">
                  <strong>
                    {config.demo ? 'Example community member' : `X author ${p.authorId}`}
                  </strong>
                  <span>
                    ·{' '}
                    {new Date(p.createdAt).toLocaleTimeString('en', {
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: 'UTC',
                    })}{' '}
                    UTC
                  </span>
                </div>
                <p>{p.text}</p>
                <div className="post-author" style={{ marginTop: 12 }}>
                  {compact(p.interactions)} observed interactions
                </div>
                {!config.demo && (
                  <a
                    href={`https://x.com/i/web/status/${p.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View original post <ArrowUpRight size={12} />
                  </a>
                )}
              </article>
            ))}
            {!raid.activity.length && (
              <Empty title="The conversation is just beginning">
                Qualifying posts will appear after the next collection cycle.
              </Empty>
            )}
          </section>
        </div>
        <aside>
          {raid.mint && (
            <MarketPanel
              market={raid.market}
              at={raid.marketAt}
              error={raid.marketError}
              demo={config.demo}
            />
          )}
          <div className="panel">
            <h2>Campaign details</h2>
            <p className="small-print">{raid.mint ? 'Token mint' : 'Project'}</p>
            <p className="mint">{raid.mint || raid.name}</p>
            <p className="small-print">
              Creator access is approved for this pilot. Approval is not a token endorsement.
            </p>
          </div>
          {raid.status === 'ACTIVE' && !tracking && (
            <div className="panel">
              <SubmitPost id={raid.id} demo={config.demo} />
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
