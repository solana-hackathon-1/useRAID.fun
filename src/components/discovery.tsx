'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Search,
  Flame,
  Radio,
  Zap,
  Clock3,
  ArrowUpRight,
  ArrowDown,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import type { RaidView } from '@/lib/types';
import { RaidCard, TokenIcon, Sparkline, Freshness, compact, AboutAside, Empty } from './ui';
import { AutoRefresh, track } from './refresh';
const tabs = [
  { name: 'Trending', icon: Flame },
  { name: 'Live', icon: Radio },
  { name: 'Rising', icon: Zap },
  { name: 'New raids', icon: Clock3 },
];
export function Discovery({ raids, demo }: { raids: RaidView[]; demo: boolean }) {
  const [tab, setTab] = useState('Trending'),
    [search, setSearch] = useState(''),
    [onlyFresh, setOnlyFresh] = useState(false);
  useEffect(() => {
    if (!demo) track('discovery_view');
  }, [demo]);
  const active = raids.filter((r) => r.status === 'ACTIVE');
  const sorted = useMemo(
    () =>
      active
        .filter((r) =>
          `${r.symbol} ${r.name} ${r.title} ${r.mint}`.toLowerCase().includes(search.toLowerCase()),
        )
        .filter((r) => !onlyFresh || r.freshness === 'fresh' || r.freshness === 'demo')
        .filter((r) => tab !== 'Rising' || (r.raiders >= 5 && r.delta !== null && r.delta > 0))
        .sort((a, b) =>
          tab === 'New raids'
            ? +new Date(b.createdAt) - +new Date(a.createdAt)
            : tab === 'Rising'
              ? (b.delta || 0) - (a.delta || 0)
              : b.score - a.score,
        ),
    [raids, search, tab, onlyFresh],
  );
  const featured = [...active].sort((a, b) => b.score - a.score).slice(0, 3);
  return (
    <>
      <AutoRefresh />
      <section className="intro">
        <div>
          <div className="network-label">
            <span className="solana-symbol">≋</span> The attention layer of Solana
          </div>
          <h1>
            See where the
            <br />
            community shows up.
          </h1>
          <p>
            Discover the campaigns starting conversations.
            <br className="desktop-break" /> Follow the attention. Understand the momentum.
          </p>
        </div>
        <div className="intro-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <div className="signal-core">
            <Radio size={50} />
          </div>
          <span className="art-node node-a">B</span>
          <span className="art-node node-b">◎</span>
          <span className="art-node node-c">W</span>
          <span className="art-node node-d">J</span>
          <span className="signal-label">
            <i /> Community signal
          </span>
        </div>
      </section>
      <section className="overview-strip" aria-label="Campaign overview">
        <div>
          <span className="dot green" /> {demo ? 'Preview network' : 'Campaign network'}
        </div>
        <div>
          <strong>{active.length}</strong>
          <span>live raids</span>
        </div>
        <div>
          <strong>{compact(active.reduce((a, r) => a + r.posts, 0))}</strong>
          <span>raid posts</span>
        </div>
        <div>
          <strong>{compact(active.reduce((a, r) => a + r.interactions, 0))}</strong>
          <span>observed interactions</span>
        </div>
        <span className="strip-end">
          {demo ? 'Illustrative metrics' : 'Updates every 5 minutes'}
        </span>
      </section>
      <section className="featured">
        <div className="section-heading">
          <h2>
            <Zap size={19} /> In the spotlight
          </h2>
          <span>Communities making moves</span>
        </div>
        <div className="featured-grid">
          {featured.map((r) => (
            <RaidCard key={r.id} raid={r} />
          ))}
          {!featured.length && (
            <Empty title="The next conversation starts here">
              Approved projects can launch a campaign from the creator studio.
            </Empty>
          )}
        </div>
      </section>
      <div className="discovery-layout">
        <section className="discovery-main">
          <div className="section-heading">
            <h2>Solana, in conversation</h2>
            <span className="count-label">{active.length} active campaigns</span>
          </div>
          <div className="table-toolbar">
            <div className="tabs" role="tablist" aria-label="Discovery view">
              {tabs.map((t) => (
                <button
                  key={t.name}
                  role="tab"
                  aria-selected={tab === t.name}
                  className={tab === t.name ? 'active' : ''}
                  onClick={() => setTab(t.name)}
                >
                  <t.icon size={15} />
                  {t.name}
                </button>
              ))}
            </div>
            <button
              className={`icon-button ${onlyFresh ? 'on' : ''}`}
              title="Show current data only"
              aria-label="Show current data only"
              aria-pressed={onlyFresh}
              onClick={() => setOnlyFresh(!onlyFresh)}
            >
              <SlidersHorizontal size={17} />
            </button>
          </div>
          <label className="search-box">
            <Search size={17} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tokens, campaigns, or mint address"
              aria-label="Search campaigns"
            />
          </label>
          <div className="table-scroll">
            <table className="raid-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Token / campaign</th>
                  <th>
                    <Users size={12} /> Raiders
                  </th>
                  <th>Interactions</th>
                  <th>
                    Score <ArrowDown size={12} />
                  </th>
                  <th>Momentum</th>
                  <th aria-label="Open raid" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr key={r.id}>
                    <td className="rank">{String(i + 1).padStart(2, '0')}</td>
                    <td>
                      <Link className="token-cell" href={`/raids/${r.id}`}>
                        <TokenIcon symbol={r.symbol} />
                        <span>
                          <strong>
                            {r.symbol}
                            <small>{r.name}</small>
                          </strong>
                          <span className="campaign-title">{r.title}</span>
                          {r.freshness !== 'fresh' && r.freshness !== 'demo' && (
                            <Freshness raid={r} />
                          )}
                        </span>
                      </Link>
                    </td>
                    <td>{r.freshness === 'unavailable' ? '—' : compact(r.raiders)}</td>
                    <td>{r.freshness === 'unavailable' ? '—' : compact(r.interactions)}</td>
                    <td className="score-cell">
                      {r.freshness === 'unavailable' ? '—' : r.score.toLocaleString()}
                    </td>
                    <td>
                      <div className="momentum-cell">
                        <span
                          className={r.momentum !== null && r.momentum >= 0 ? 'positive' : 'muted'}
                        >
                          {r.momentum === null
                            ? 'Building baseline'
                            : `${r.momentum > 0 ? '+' : ''}${r.momentum}%`}
                        </span>
                        <Sparkline points={r.history.map((p) => p.score)} />
                      </div>
                    </td>
                    <td>
                      <Link
                        href={`/raids/${r.id}`}
                        className="row-arrow"
                        aria-label={`Open ${r.symbol} raid`}
                      >
                        <ArrowUpRight size={17} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!sorted.length && (
            <Empty title={search ? 'No matching campaigns' : 'No campaigns in this view'}>
              {search
                ? 'Try a token symbol or a different search.'
                : 'Try another view or return when more activity has been measured.'}
            </Empty>
          )}
          <div className="table-footer">
            <span>Showing {sorted.length} campaigns</span>
            {sorted[0] && <Freshness raid={sorted[0]} />}
          </div>
        </section>
        <div className="discovery-aside">
          <AboutAside />
          <div className="participate-box">
            <span className="line-icon">
              <Radio size={22} />
            </span>
            <h3>
              Your community.
              <br />
              Your next raid.
            </h3>
            <p>Give your next announcement a place to gather momentum.</p>
            <Link href="/creator">
              Start a campaign <ArrowUpRight size={15} />
            </Link>
          </div>
          <p className="small-print">
            Attention is measured activity, not investment merit. Always do your own research.
          </p>
        </div>
      </div>
    </>
  );
}
