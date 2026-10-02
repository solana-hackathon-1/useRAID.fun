'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Plus, ArrowUpRight } from 'lucide-react';
import { formatUsdc } from '@/lib/usdc-amount';

export type StudioCard = {
  id: string;
  title: string;
  symbol: string;
  imageUri: string | null;
  status: string;
  phase: string;
  pool: string | null;
  currency: string;
  views: number;
  target: number | null;
  raiders: number;
  endsAt: string;
  paid: boolean;
  legacy: boolean;
};
export function StudioHome({
  available,
  reserved,
  raids,
}: {
  available: string;
  reserved: string;
  raids: StudioCard[];
}) {
  const [filter, setFilter] = useState('All');
  const filtered = raids.filter(
    (r) =>
      filter === 'All' ||
      (filter === 'Live'
        ? ['ACTIVE', 'SCHEDULED'].includes(r.status)
        : filter === 'Drafts'
          ? r.status === 'DRAFT'
          : r.status === 'ENDED'),
  );
  return (
    <div className="studio">
      <header className="studio-heading">
        <div>
          <h1>Creator Studio</h1>
          <p>Your next Raid starts with a post.</p>
        </div>
        <Link className="button" href="/creator/new">
          <Plus size={18} /> Create Raid
        </Link>
      </header>
      <div className="studio-balance">
        <div>
          <span>Available balance</span>
          <strong>
            {formatUsdc(available)} <small>USDC</small>
          </strong>
          {BigInt(reserved) > 0n && <p>{formatUsdc(reserved)} USDC reserved</p>}
        </div>
        <Link className="inline-link" href="/creator/balance">
          Manage balance <ArrowUpRight size={15} />
        </Link>
      </div>
      <section className="studio-list">
        <div className="studio-list-heading">
          <h2>Your Raids</h2>
          <div className="studio-tabs" aria-label="Filter Raids">
            {['All', 'Live', 'Drafts', 'Ended'].map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>
        {!filtered.length && (
          <div className="studio-empty">
            <h3>{raids.length ? 'No Raids here yet' : 'Create your first Raid'}</h3>
            <p>Add X posts, choose your impression target, and fund your community.</p>
            <Link className="button secondary" href="/creator/new">
              Create Raid
            </Link>
          </div>
        )}
        {filtered.map((raid) => (
          <article key={raid.id} className="studio-raid-row">
            <div className="studio-identity">
              {raid.imageUri ? (
                <img src={raid.imageUri} alt="" className="studio-token-image" />
              ) : (
                <span className="studio-token-placeholder">
                  {(raid.symbol || raid.title).slice(0, 2).toUpperCase()}
                </span>
              )}
              <div>
                <span className={`studio-status ${raid.status === 'ACTIVE' ? 'live' : ''}`}>
                  {raid.status === 'ACTIVE'
                    ? 'Live'
                    : raid.status === 'DRAFT'
                      ? 'Draft'
                      : raid.status === 'SCHEDULED'
                        ? 'Scheduled'
                        : 'Ended'}
                  {raid.legacy ? ' · Legacy SOL' : ''}
                </span>
                <h3>{raid.title}</h3>
                <p>
                  {raid.pool
                    ? `${raid.currency === 'USDC' ? formatUsdc(raid.pool) : (Number(raid.pool) / 1e9).toFixed(4)} ${raid.currency === 'LAUNCH' ? 'SOL + token' : raid.currency} rewards`
                    : 'Funding quote pending'}
                  {raid.status === 'ACTIVE'
                    ? ` · ${Math.max(0, Math.ceil((Date.parse(raid.endsAt) - Date.now()) / 3600000))}h left`
                    : raid.status === 'ENDED'
                      ? ` · ${raid.paid ? 'Paid' : raid.phase === 'ALLOCATED' ? 'Payments pending' : 'Results under review'}`
                      : ''}
                </p>
              </div>
            </div>
            <div className="studio-row-progress">
              {raid.target && (
                <>
                  <span>
                    {raid.views.toLocaleString()} / {raid.target.toLocaleString()} impressions
                  </span>
                  <progress max={raid.target} value={Math.min(raid.views, raid.target)} />
                </>
              )}
              <span>{raid.raiders} raiders</span>
            </div>
            <Link
              className="button secondary small"
              href={
                raid.status === 'DRAFT' && !raid.legacy && raid.currency !== 'LAUNCH'
                  ? `/creator/new?draft=${raid.id}`
                  : `/creator/raids/${raid.id}`
              }
            >
              {raid.status === 'DRAFT'
                ? 'Continue draft'
                : raid.status === 'ENDED'
                  ? 'Results'
                  : 'Manage Raid'}
            </Link>
          </article>
        ))}
      </section>
    </div>
  );
}
