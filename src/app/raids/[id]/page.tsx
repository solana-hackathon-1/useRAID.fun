import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { getRaid } from '@/lib/data';
import { config } from '@/lib/config';
import { composeUrl, tradeUrl } from '@/lib/domain';
import { TokenIcon, Freshness, Sparkline, compact, Empty } from '@/components/ui';
import { AutoRefresh } from '@/components/refresh';
import { ExternalActions, SubmitPost } from '@/components/actions';
import { MarketPanel } from '@/components/market';
export const dynamic = 'force-dynamic';
export default async function RaidPage({ params }: { params: Promise<{ id: string }> }) {
  const raid = await getRaid((await params).id);
  if (!raid) notFound();
  return (
    <>
      <AutoRefresh />
      <div className="breadcrumb">
        <Link href="/">
          <ArrowLeft size={13} style={{ display: 'inline' }} /> Discovery
        </Link>
        <span>/</span>
        <span>{raid.symbol} raid</span>
      </div>
      <div className="detail-header">
        <div className="detail-title">
          <TokenIcon symbol={raid.symbol} large />
          <div>
            <h1>
              {raid.symbol}
              <span className="muted"> / raid</span>
            </h1>
            <p>
              {raid.name} ·{' '}
              <Link className="inline-link" href={`/tokens/${raid.mint}`}>
                View token profile
              </Link>
            </p>
          </div>
        </div>
        <ExternalActions
          demo={config.demo}
          raidId={raid.id}
          compose={composeUrl(config.handle, raid.tag)}
          trade={tradeUrl(raid.mint)}
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
              <span className="status-pill">
                {raid.status === 'ACTIVE' ? 'Live campaign' : 'Campaign ended'}
              </span>
              <Freshness raid={raid} />
            </div>
            <h2 style={{ fontSize: 26, marginTop: 23 }}>{raid.title}</h2>
            <p className="campaign-copy">{raid.description}</p>
            <p className="small-print">
              {raid.status === 'ACTIVE' ? 'Ends' : 'Ended'}{' '}
              {new Date(raid.endsAt).toLocaleString('en', { timeZone: 'UTC' })} UTC
            </p>
            <div className="metric-grid">
              <div>
                <span>Attention score</span>
                <strong>
                  {raid.freshness === 'unavailable' ? '—' : raid.score.toLocaleString()}
                </strong>
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
              <Sparkline points={raid.history.map((h) => h.score)} />
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
              Experimental score v1 measures attributed activity. It does not assess project quality
              or predict price.{' '}
              <Link className="inline-link" href="/methodology">
                See the formula.
              </Link>
            </p>
          </section>
          <section className="panel">
            <h2>Join the conversation</h2>
            <div className="instruction">
              <p>
                Write an original post on X. Include <code>@{config.handle}</code> and{' '}
                <code>#{raid.tag}</code> during the campaign. Posts with multiple raid tags won’t
                count.
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
          <MarketPanel
            market={raid.market}
            at={raid.marketAt}
            error={raid.marketError}
            demo={config.demo}
          />
          <div className="panel">
            <h2>Campaign details</h2>
            <p className="small-print">Token mint</p>
            <p className="mint">{raid.mint}</p>
            <p className="small-print">
              Creator access is approved for this pilot. Approval is not a token endorsement.
            </p>
          </div>
          {raid.status === 'ACTIVE' && (
            <div className="panel">
              <SubmitPost id={raid.id} demo={config.demo} />
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
