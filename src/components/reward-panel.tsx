'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { WalletLogin } from './wallet-login';
type View = Awaited<ReturnType<typeof import('@/lib/reward-view').publicRewardView>>;
const sol = (value: string) => `${(Number(BigInt(value)) / 1e9).toFixed(5)} SOL`;
export function RewardPanel({
  view,
  walletAddress,
  xConnected,
}: {
  view: NonNullable<View>;
  walletAddress: string | null;
  xConnected: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function action(kind: 'enroll' | 'renew') {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/launch/${view.id}/${kind}`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Action failed.');
      setMessage(kind === 'enroll' ? 'Enrolled for rewards.' : 'New 24-hour raid started.');
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }
  const pending = ['PENDING', 'READY', 'SENT'].reduce(
    (sum, status) => sum + BigInt(view.personalTotals[status] || '0'),
    0n,
  );
  const paid = BigInt(view.personalTotals.PAID || '0');
  return (
    <section className="panel">
      <h2>Creator-fee rewards</h2>
      <p>
        pump.fun creator fees arrive at <code className="mint">{view.feeAddress}</code>. After
        network costs, 90% goes to qualifying raiders and 10% to useRAID.
      </p>
      {view.status === 'PAUSED' && <p className="notice">Payouts paused: {view.pausedReason}</p>}
      {view.globalPauseReason && <p className="notice">{view.globalPauseReason}</p>}
      {view.settlementDelayed && (
        <p className="notice">
          Hourly settlement delayed while X collection or refresh is incomplete.
        </p>
      )}
      <p className="small-print">Hourly rounds · balances under 0.001 SOL carry forward.</p>
      <WalletLogin currentAddress={walletAddress} />
      {!xConnected && (
        <p>
          <Link className="inline-link" href="/creator">
            Connect verified X account
          </Link>{' '}
          to qualify.
        </p>
      )}
      {walletAddress && xConnected && view.activeRaid && !view.enrolled && (
        <button className="button" disabled={busy} onClick={() => void action('enroll')}>
          Join raider rewards
        </button>
      )}
      {view.enrolled && <p className="status-pill">Enrolled · {view.enrolledWallet}</p>}
      {view.owner && !view.activeRaid && (
        <button className="button secondary" disabled={busy} onClick={() => void action('renew')}>
          Start new 24-hour raid
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {(pending > 0n || paid > 0n) && (
        <p>
          Your rewards: {sol(pending.toString())} pending · {sol(paid.toString())} paid
        </p>
      )}
      <h3>Recent rounds</h3>
      {view.rounds.length ? (
        view.rounds.map((r) => (
          <div className="campaign-manage" key={r.startsAt}>
            <strong>{new Date(r.endsAt).toLocaleString()}</strong>
            <p>
              {r.status} · {sol(r.grossLamports)} claimed · {sol(r.costLamports)} costs ·{' '}
              {sol(r.raiderLamports)} raiders · {sol(r.platformLamports)} platform
            </p>
          </div>
        ))
      ) : (
        <p>No settled rounds yet.</p>
      )}
      <h3>Completed payouts</h3>
      {view.paidHistory.map((p, i) => (
        <p key={`${p.signature}:${i}`}>
          {sol(p.lamports)} · {p.walletAddress.slice(0, 4)}…{p.walletAddress.slice(-4)} ·{' '}
          <a href={`https://solscan.io/tx/${p.signature}`} target="_blank" rel="noreferrer">
            Transaction
          </a>
        </p>
      ))}
    </section>
  );
}
