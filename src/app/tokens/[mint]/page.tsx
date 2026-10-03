import Link from 'next/link';
import { launchpadsAvailable } from '@/lib/release';
import { notFound } from 'next/navigation';
import { getToken } from '@/lib/data';
import { config } from '@/lib/config';
import { TokenIcon, RaidCard, compact, Freshness, CampaignStatus, Empty } from '@/components/ui';
import { MarketPanel } from '@/components/market';
import { AutoRefresh } from '@/components/refresh';
import { publicRewardView } from '@/lib/reward-view';
import { RewardPanel } from '@/components/reward-panel';
import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { formatUtcDate } from '@/lib/format';
export const dynamic = 'force-dynamic';
export default async function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const token = await getToken((await params).mint);
  if (!token) notFound();
  const user = await currentUser();
  const rewards = launchpadsAvailable ? await publicRewardView(token.mint, user?.id) : null;
  const [wallet, xAccount] = user
    ? await Promise.all([
        db.walletIdentity.findUnique({ where: { userId: user.id } }),
        db.xAccount.findUnique({ where: { userId: user.id } }),
      ])
    : [null, null];
  const active = token.raids.filter((r) => r.status === 'ACTIVE');
  return (
    <>
      <AutoRefresh active={token.raids.some((r) => r.status === 'ACTIVE')} />
      <div className="breadcrumb">
        <Link href="/">Discovery</Link>
        <span>/</span>
        {token.symbol}
      </div>
      <div className="detail-header">
        <div className="detail-title">
          {rewards?.imageUri ? (
            <img
              className="token-launch-logo"
              src={`https://gateway.pinata.cloud/ipfs/${rewards.imageUri.slice(7)}`}
              alt={`${token.name} logo`}
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          ) : (
            <TokenIcon symbol={token.symbol} imageUri={token.imageUri} large />
          )}
          <div>
            <h1>{token.name}</h1>
            <p>${token.symbol} · Solana</p>
            {token.metadataSource === 'CREATOR' && (
              <p>
                <small>Unverified — supplied by a campaign creator</small>
              </p>
            )}
          </div>
        </div>
        {active[0] && (
          <Link className="button" href={`/raids/${active[0].id}`}>
            Join live raid
          </Link>
        )}
      </div>
      <div className="detail-grid">
        <div>
          <section className="panel">
            <div className="section-heading">
              <h2>Community attention</h2>
              <Freshness raid={token} />
            </div>
            <div className="metric-grid">
              <div>
                <span>Attention score</span>
                <strong>
                  {token.freshness === 'unavailable' ? '—' : compact(token.totals.score)}
                </strong>
              </div>
              <div>
                <span>Unique raiders</span>
                <strong>
                  {token.freshness === 'unavailable' ? '—' : compact(token.totals.raiders)}
                </strong>
              </div>
              <div>
                <span>Qualifying posts</span>
                <strong>
                  {token.freshness === 'unavailable' ? '—' : compact(token.totals.posts)}
                </strong>
              </div>
              <div>
                <span>Interactions</span>
                <strong>
                  {token.freshness === 'unavailable' ? '—' : compact(token.totals.interactions)}
                </strong>
              </div>
            </div>
            <p className="small-print">
              Participants and posts are deduplicated across this token’s campaigns. Activity covers
              attributed campaigns only.
            </p>
          </section>
          <div className="section-heading">
            <h2>Active campaigns</h2>
            <span>{active.length} live</span>
          </div>
          <div
            className="featured-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}
          >
            {active.map((r) => (
              <RaidCard key={r.id} raid={r} />
            ))}
            {!active.length && (
              <Empty title="No active campaigns">
                This token’s past campaigns remain available below.
              </Empty>
            )}
          </div>
          <section className="panel" style={{ marginTop: 25 }}>
            <h2>Campaign history</h2>
            {token.raids.map((r) => (
              <div className="campaign-manage" key={r.id}>
                <Link href={`/raids/${r.id}`}>
                  <strong>{r.title}</strong>
                </Link>
                <p>
                  <CampaignStatus status={r.status} demo={config.demo} /> ·{' '}
                  {formatUtcDate(r.startsAt)} · {compact(r.raiders)} raiders
                </p>
              </div>
            ))}
          </section>
          {rewards && (
            <RewardPanel
              view={rewards}
              walletAddress={wallet?.address || null}
              xConnected={!!xAccount}
            />
          )}
        </div>
        <aside>
          <MarketPanel
            market={token.market}
            at={token.marketAt}
            error={token.marketError}
            demo={config.demo}
          />
          <div className="panel">
            <h2>Token identity</h2>
            <p className="mint">{token.mint}</p>
            <p className="small-print">
              Use the mint address to identify a token. Names and symbols are not unique.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
