import Link from 'next/link';
import { ArrowUpRight, Radio, Flame, ShieldCheck } from 'lucide-react';
import type { RaidView } from '@/lib/types';
export const compact = (n: number | null | undefined) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const money = (n: number | null | undefined) =>
  n == null ? 'Unavailable' : `$${compact(n)}`;
export function TokenIcon({ symbol, large = false }: { symbol: string; large?: boolean }) {
  const index = [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0) % 6;
  return (
    <span className={`token-icon token-${index} ${large ? 'large' : ''}`} aria-hidden="true">
      {symbol.slice(0, 1)}
      <i />
    </span>
  );
}
export function Freshness({ raid }: { raid: Pick<RaidView, 'freshness' | 'observedAt'> }) {
  return (
    <span className={`freshness ${raid.freshness}`}>
      <i />
      {raid.freshness === 'demo'
        ? 'Example data'
        : raid.freshness === 'fresh'
          ? 'Updated ' +
            new Date(raid.observedAt!).toLocaleTimeString('en', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'UTC',
            }) +
            ' UTC'
          : raid.freshness === 'unavailable'
            ? 'Awaiting collection'
            : raid.freshness === 'partial'
              ? 'Partial coverage'
              : 'Data is stale'}
    </span>
  );
}
export function Sparkline({ points, muted = false }: { points: number[]; muted?: boolean }) {
  if (points.length < 2) return <span className="muted">Building history</span>;
  const min = Math.min(...points),
    max = Math.max(...points);
  const path = points
    .map((p, i) => `${(i * 110) / (points.length - 1)},${32 - ((p - min) / (max - min || 1)) * 26}`)
    .join(' ');
  return (
    <svg
      className={`sparkline ${muted ? 'muted' : ''}`}
      viewBox="0 0 110 38"
      aria-label="Recent attention score"
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function RaidCard({ raid }: { raid: RaidView }) {
  return (
    <Link href={`/raids/${raid.id}`} className="raid-card">
      <div className="card-top">
        <TokenIcon symbol={raid.symbol} />
        <div>
          <strong>{raid.symbol}</strong>
          <span className="muted">{raid.name}</span>
        </div>
        <span className="live-chip">
          <Radio size={12} /> Live
        </span>
      </div>
      <h3>{raid.title}</h3>
      <div className="card-bottom">
        <div>
          <span className="muted">Attention score</span>
          <strong>{raid.freshness === 'unavailable' ? '—' : raid.score.toLocaleString()}</strong>
        </div>
        <div className="card-growth">
          {raid.momentum == null ? 'New baseline' : `+${raid.momentum}%`}
          <Sparkline points={raid.history.map((x) => x.score)} />
        </div>
      </div>
      <div className="card-foot">
        <span>
          {raid.freshness === 'unavailable'
            ? 'Awaiting collection'
            : `${compact(raid.raiders)} raiders participating`}
        </span>
        <ArrowUpRight size={16} />
      </div>
    </Link>
  );
}
export function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="empty">
      <Radio size={30} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function AboutAside() {
  return (
    <aside className="about-box">
      <span className="mini-mark">
        <Flame size={21} />
      </span>
      <h3>Attention has a story.</h3>
      <p>
        Find the communities showing up, the ideas catching on, and the people behind the momentum.
      </p>
      <Link href="/methodology">
        How attention is measured <ArrowUpRight size={14} />
      </Link>
      <div className="aside-note">
        <ShieldCheck size={16} />
        <span>Measured activity. Never an endorsement.</span>
      </div>
    </aside>
  );
}
