import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getToken } from '@/lib/data';
import { config } from '@/lib/config';
import { TokenIcon, RaidCard, compact, Freshness } from '@/components/ui';
import { MarketPanel } from '@/components/market';
import { AutoRefresh } from '@/components/refresh';
import { ExternalActions } from '@/components/actions';
import { composeUrl, tradeUrl } from '@/lib/domain';
export const dynamic = 'force-dynamic';
export default async function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const token = await getToken((await params).mint);
  if (!token) notFound();
  const active = token.raids.filter((r) => r.status === 'ACTIVE');
  return (
    <>
      <AutoRefresh />
      <div className="breadcrumb">
        <Link href="/">Discovery</Link>
        <span>/</span>
        {token.symbol}
      </div>
      <div className="detail-header">
        <div className="detail-title">
          <TokenIcon symbol={token.symbol} large />
          <div>
            <h1>{token.name}</h1>
            <p>${token.symbol} · Solana</p>
          </div>
        </div>
        <ExternalActions
          demo={config.demo}
          raidId={token.raids[0].id}
          compose={composeUrl(config.handle, token.raids[0].tag)}
          trade={tradeUrl(token.mint)}
          active={false}
        />
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
          </div>
          <section className="panel" style={{ marginTop: 25 }}>
            <h2>Campaign history</h2>
            {token.raids.map((r) => (
              <div className="campaign-manage" key={r.id}>
                <Link href={`/raids/${r.id}`}>
                  <strong>{r.title}</strong>
                </Link>
                <p>
                  {r.status.toLowerCase()} ·{' '}
                  {new Date(r.startsAt).toLocaleDateString('en', { timeZone: 'UTC' })} ·{' '}
                  {compact(r.raiders)} raiders
                </p>
              </div>
            ))}
          </section>
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
