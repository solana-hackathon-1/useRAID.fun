import Link from 'next/link';
import { ArrowUpRight, Radio } from 'lucide-react';
import type { RaidView } from '@/lib/types';
import { formatUsdc } from '@/lib/usdc-amount';
import { formatNumber } from '@/lib/format';
export const compact = (n: number | null | undefined) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const money = (n: number | null | undefined) =>
  n == null ? 'Unavailable' : `$${compact(n)}`;
export function TokenIcon({
  symbol,
  large = false,
  imageUri,
}: {
  symbol: string;
  large?: boolean;
  imageUri?: string | null;
}) {
  if (imageUri)
    return (
      <img
        src={imageUri}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        className={`token-icon ${large ? 'large' : ''}`}
        style={{ objectFit: 'cover' }}
      />
    );
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
export function CampaignStatus({ status, demo = false }: { status: string; demo?: boolean }) {
  const active = status === 'ACTIVE';
  const label = demo
    ? 'Example'
    : active
      ? 'Active'
      : status === 'SCHEDULED'
        ? 'Scheduled'
        : status === 'DRAFT'
          ? 'Draft'
          : 'Ended';
  return (
    <span className={`status-pill ${demo || !active ? 'neutral' : ''}`}>
      {active && !demo && <Radio size={12} />}
      {label}
    </span>
  );
}
export function AttentionChart({ history }: { history: RaidView['history'] }) {
  if (history.length < 2)
    return (
      <div className="chart-empty">
        <p>Building history</p>
        <p className="small-print">Attention measurements will appear as they are collected.</p>
      </div>
    );
  const start = +new Date(history[0].at),
    end = +new Date(history[history.length - 1].at);
  const max = Math.max(1, ...history.map((point) => point.score));
  const path = history
    .map(
      (point) =>
        `${48 + ((+new Date(point.at) - start) / (end - start || 1)) * 580},${192 - (point.score / max) * 164}`,
    )
    .join(' ');
  const formatTime = (at: string) =>
    new Date(at).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    });
  return (
    <svg
      className="attention-chart"
      viewBox="0 0 660 236"
      role="img"
      aria-label={`Attention score from ${formatTime(history[0].at)} to ${formatTime(history[history.length - 1].at)} UTC. Latest score ${formatNumber(history[history.length - 1].score)}.`}
    >
      {[0, 0.5, 1].map((fraction) => (
        <g key={fraction}>
          <line
            className="chart-grid"
            x1="48"
            x2="628"
            y1={192 - fraction * 164}
            y2={192 - fraction * 164}
          />
          <text className="chart-axis" x="36" y={196 - fraction * 164} textAnchor="end">
            {compact(Math.round(max * fraction))}
          </text>
        </g>
      ))}
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {history.map((point, index) => (
        <circle
          key={`${point.at}-${index}`}
          cx={48 + ((+new Date(point.at) - start) / (end - start || 1)) * 580}
          cy={192 - (point.score / max) * 164}
          r="3"
          fill="currentColor"
        >
          <title>{`${formatTime(point.at)} UTC: ${point.score.toLocaleString('en-US')}`}</title>
        </circle>
      ))}
      <text className="chart-axis" x="48" y="224">
        {formatTime(history[0].at)} UTC
      </text>
      <text className="chart-axis" x="628" y="224" textAnchor="end">
        {formatTime(history[history.length - 1].at)} UTC
      </text>
    </svg>
  );
}
export function RaidCard({ raid }: { raid: RaidView }) {
  return (
    <Link href={`/raids/${raid.id}`} className="raid-card">
      <div className="card-top">
        <TokenIcon symbol={raid.symbol} imageUri={raid.imageUri} />
        <div>
          <strong>{raid.mint ? raid.symbol : 'X Campaign'}</strong>
          <span className="muted">{raid.name}</span>
        </div>
        <span className="live-chip neutral">
          <CampaignStatus status={raid.status} demo={raid.freshness === 'demo'} />
        </span>
      </div>
      <h3>{raid.title}</h3>
      {raid.fundingAsset === 'USDC' && raid.poolUnits && (
        <p>{formatUsdc(raid.poolUnits)} USDC rewards</p>
      )}
      {raid.fundingAsset === 'LAUNCH' && raid.poolUnits && <p>{(Number(raid.poolUnits)/1e9).toFixed(4)} SOL + optional token rewards</p>}
      <div className="card-bottom">
        <div>
          <span className="muted">Attention score</span>
          <strong>{raid.freshness === 'unavailable' ? '—' : formatNumber(raid.score)}</strong>
        </div>
        <div
          className={`card-growth ${raid.momentum !== null && raid.momentum < 0 ? 'negative' : ''}`}
        >
          {raid.freshness === 'unavailable'
            ? '—'
            : raid.momentum == null
              ? 'Building baseline'
              : `${raid.momentum > 0 ? '+' : ''}${raid.momentum}%`}
          {raid.freshness !== 'unavailable' && (
            <Sparkline points={raid.history.map((x) => x.score)} />
          )}
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
      <div className="card-freshness">
        <Freshness raid={raid} />
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
