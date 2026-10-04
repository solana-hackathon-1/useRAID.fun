'use client';
import { useEffect, useMemo, useState } from 'react';
import { formatUsdc } from '@/lib/usdc-amount';
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
import { RaidCard, TokenIcon, Sparkline, Freshness, compact, Empty } from './ui';
import { AutoRefresh, track } from './refresh';
import { RaidArtwork } from './brand';
import styles from './discovery.module.css';
import { formatNumber } from '@/lib/format';
import { discoveryRows } from '@/lib/discovery-rows';
import { MeteoraDiscovery } from './meteora-discovery';
import type { launchDiscovery } from '@/lib/meteora/view';
const tabs = [
  { name: 'Trending', icon: Flame },
  { name: 'Live', icon: Radio },
  { name: 'Rising', icon: Zap },
  { name: 'New raids', icon: Clock3 },
];
export function Discovery({
  raids,
  demo,
  launches = [],
  launchesOpen = false,
}: {
  raids: RaidView[];
  demo: boolean;
  launches?: Awaited<ReturnType<typeof launchDiscovery>>;
  launchesOpen?: boolean;
}) {
  const [tab, setTab] = useState('Trending'),
    [search, setSearch] = useState(''),
    [onlyFresh, setOnlyFresh] = useState(false);
  useEffect(() => {
    if (!demo) track('discovery_view');
  }, [demo]);
  const active = raids.filter((r) => r.status === 'ACTIVE');
  const sorted = useMemo(
    () => discoveryRows(raids, tab, search, onlyFresh, Date.now()),
    [raids, search, tab, onlyFresh],
  );
  const featured = [...active]
    .sort((a, b) => Number(!!b.mint) - Number(!!a.mint) || b.score - a.score)
    .slice(0, 3);
  return (
    <>
      <AutoRefresh />
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <h1>
            Make your
            <br />
            community heard.
          </h1>
          <p>
            Discover project raids, join the conversation on X, and follow measured community
            attention.
          </p>
          <div className="form-actions">
            <a className="button" href="#discovery">
              Explore raids <ArrowDown size={16} />
            </a>
            <Link className="button secondary" href="/creator">
              Create a raid
            </Link>
          </div>
        </div>
        <RaidArtwork />
      </section>
      <section className="overview-strip" aria-label="Campaign overview">
        <div>
          <span className="dot green" /> {demo ? 'Preview network' : 'Campaign network'}
        </div>
        <div>
          <strong>{active.length}</strong>
          <span>{demo ? 'example raids' : 'active raids'}</span>
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
              Connect X and fund a campaign from Creator Studio.
            </Empty>
          )}
        </div>
      </section>
      <div className="discovery-layout">
        <section className="discovery-main" id="discovery" aria-labelledby="discovery-heading">
          <div className="section-heading">
            <h2 id="discovery-heading">Find your next raid</h2>
            <span className="count-label">{active.length} active campaigns</span>
          </div>
          <div className="table-toolbar">
            <div className="tabs" role="tablist" aria-label="Discovery view">
              {tabs.map((t) => (
                <button
                  key={t.name}
                  role="tab"
                  id={`tab-${t.name.replaceAll(' ', '-')}`}
                  aria-controls="campaign-results"
                  tabIndex={tab === t.name ? 0 : -1}
                  onKeyDown={(event) => {
                    const index = tabs.findIndex((item) => item.name === t.name);
                    const next =
                      event.key === 'ArrowRight'
                        ? (index + 1) % tabs.length
                        : event.key === 'ArrowLeft'
                          ? (index + tabs.length - 1) % tabs.length
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? tabs.length - 1
                              : null;
                    if (next !== null) {
                      event.preventDefault();
                      setTab(tabs[next].name);
                      document
                        .getElementById(`tab-${tabs[next].name.replaceAll(' ', '-')}`)
                        ?.focus();
                    }
                  }}
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
              className={`filter-button ${onlyFresh ? 'on' : ''}`}
              title="Show current data only"
              aria-label="Show current data only"
              aria-pressed={onlyFresh}
              onClick={() => setOnlyFresh(!onlyFresh)}
            >
              <SlidersHorizontal size={16} /> Current data only
            </button>
          </div>
          <label className="search-box">
            <Search size={17} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects, campaigns, or mint address"
              aria-label="Search campaigns"
            />
          </label>
          <div
            className="table-scroll"
            id="campaign-results"
            role="tabpanel"
            aria-labelledby={`tab-${tab.replaceAll(' ', '-')}`}
          >
            <table className="raid-table" role="table" aria-label="Campaign rankings">
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
                  <tr key={r.id} role="row">
                    <td className="rank" role="cell" data-label="Rank">
                      {String(i + 1).padStart(2, '0')}
                    </td>
                    <td role="cell" className="identity-cell">
                      <Link className="token-cell" href={`/raids/${r.id}`}>
                        <TokenIcon symbol={r.symbol} imageUri={r.imageUri} />
                        <span>
                          <strong>
                            {r.mint ? r.symbol : 'X Campaign'}
                            <small>{r.name}</small>
                          </strong>
                          <span className="campaign-title">{r.title}</span>
                          {r.fundingAsset === 'USDC' && r.poolUnits && (
                            <span className="campaign-title">
                              {formatUsdc(r.poolUnits)} USDC rewards
                            </span>
                          )}
                          <Freshness raid={r} />
                        </span>
                      </Link>
                    </td>
                    <td role="cell" data-label="Raiders">
                      {r.freshness === 'unavailable' ? '—' : compact(r.raiders)}
                    </td>
                    <td role="cell" data-label="Interactions">
                      {r.freshness === 'unavailable' ? '—' : compact(r.interactions)}
                    </td>
                    <td role="cell" data-label="Score" className="score-cell">
                      {r.freshness === 'unavailable' ? '—' : formatNumber(r.score)}
                    </td>
                    <td role="cell" data-label="Momentum">
                      <div className="momentum-cell">
                        <span
                          className={
                            r.momentum !== null && r.momentum >= 0 ? 'positive' : 'negative'
                          }
                        >
                          {r.freshness === 'unavailable'
                            ? '—'
                            : r.momentum === null
                              ? 'Building baseline'
                              : `${r.momentum > 0 ? '+' : ''}${r.momentum}%`}
                        </span>
                        {r.freshness !== 'unavailable' && (
                          <Sparkline points={r.history.map((p) => p.score)} />
                        )}
                      </div>
                    </td>
                    <td role="cell" className="open-cell">
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
            <Empty
              title={
                search
                  ? 'No matching campaigns'
                  : tab === 'Live'
                    ? 'No posts in the last hour'
                    : 'No campaigns in this view'
              }
            >
              {search
                ? 'Try a token symbol or a different search.'
                : 'Try another view or return when more activity has been measured.'}
            </Empty>
          )}
          <div className="table-footer">
            <span role="status">Showing {sorted.length} campaigns</span>
            {sorted[0] && <Freshness raid={sorted[0]} />}
          </div>
        </section>
      </div>
      <section className={styles.participation} aria-labelledby="participation-heading">
        <div>
          <span className={styles.signal}>
            <Radio size={24} />
          </span>
          <h2 id="participation-heading">
            A community is more
            <br />
            than a number.
          </h2>
          <p>Find a campaign. Add your voice. See the attention take shape.</p>
          <Link className="inline-link" href="/methodology">
            How attention is measured <ArrowUpRight size={16} />
          </Link>
        </div>
        <ol>
          <li>
            <strong>Find your community</strong>
            <p>Explore active raids and the ideas behind them.</p>
          </li>
          <li>
            <strong>Make it your own</strong>
            <p>Join a Raid, then post on X with @useRAID in your own text.</p>
          </li>
          <li>
            <strong>Follow the conversation</strong>
            <p>See qualifying posts and measured participation, with context.</p>
          </li>
        </ol>
      </section>
      <p className="small-print">
        Attention is measured activity, not investment merit. Always do your own research.
      </p>
      {!demo && (launchesOpen || launches.length > 0) && <MeteoraDiscovery launches={launches} />}
    </>
  );
}
