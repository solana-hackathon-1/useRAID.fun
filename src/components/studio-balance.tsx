'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getWallets } from '@wallet-standard/app';
import type { StandardConnectFeature } from '@wallet-standard/features';
import type { SolanaSignAndSendTransactionFeature } from '@solana/wallet-standard-features';
import bs58 from 'bs58';
import { formatUsdc } from '@/lib/usdc-amount';
import type { BalanceView } from '@/lib/usdc';

export function StudioBalance({
  view,
  walletAddress,
  ready,
  depositReady,
  sandbox,
  returnTo,
  network,
}: {
  view: BalanceView;
  walletAddress: string | null;
  ready: boolean;
  depositReady: boolean;
  sandbox: boolean;
  returnTo: string | null;
  network: string;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState('100'),
    [action, setAction] = useState<'deposit' | 'withdraw'>('deposit'),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [pending, setPending] = useState<{ id: string; signature: string } | null>(null);
  const [withdrawalKey, setWithdrawalKey] = useState('');
  async function post(path: string, body: unknown) {
    const response = await fetch(`/api/balance/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Request failed.');
    return value;
  }
  async function verify(id: string, signature: string) {
    await post('verify', { id, signature });
    setPending(null);
    setMessage('Deposit confirmed. USDC is available.');
    router.refresh();
  }
  async function submit() {
    setBusy(true);
    setMessage('');
    try {
      if (action === 'withdraw') {
        const key = withdrawalKey || crypto.randomUUID();
        setWithdrawalKey(key);
        await post('withdraw', { amount, key });
        setWithdrawalKey('');
        setMessage('Withdrawal requested. Funds reserved until operator completes transfer.');
      } else {
        const intent = await post('deposit', { amount });
        if (sandbox) await verify(intent.id, `sandbox:${intent.id}`);
        else {
          const chain = network === 'devnet' ? 'solana:devnet' : 'solana:mainnet';
          const wallet =
            getWallets()
              .get()
              .find(
                (w) =>
                  w.chains.includes(chain) &&
                  'solana:signAndSendTransaction' in w.features &&
                  w.accounts.some((a) => a.address === walletAddress),
              ) ||
            getWallets()
              .get()
              .find(
                (w) => w.chains.includes(chain) && 'solana:signAndSendTransaction' in w.features,
              );
          if (!wallet) throw Error('Open Balance in your Solana wallet browser to sign deposit.');
          const accounts = await (wallet.features as StandardConnectFeature)[
            'standard:connect'
          ].connect();
          const account = accounts.accounts.find((a) => a.address === walletAddress);
          if (!account) throw Error('Select your verified account in wallet.');
          const result = (
            await (wallet.features as SolanaSignAndSendTransactionFeature)[
              'solana:signAndSendTransaction'
            ].signAndSendTransaction({
              account,
              chain,
              transaction: Uint8Array.from(atob(intent.transaction), (c) => c.charCodeAt(0)),
            })
          )[0];
          const signature = bs58.encode(result.signature);
          setPending({ id: intent.id, signature });
          await verify(intent.id, signature);
        }
      }
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Transfer failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="studio">
      <Link className="studio-back" href="/creator">
        ← Creator Studio
      </Link>
      <header className="studio-heading">
        <div>
          <h1>Balance</h1>
          <p>One balance for every Raid.</p>
        </div>
        {returnTo && (
          <Link className="button secondary" href={returnTo}>
            Return to draft
          </Link>
        )}
      </header>
      <div className="studio-balance large">
        <div>
          <span>Available</span>
          <strong>
            {formatUsdc(view.available)} <small>USDC</small>
          </strong>
          <p>{formatUsdc(view.reserved)} USDC reserved for Raids and withdrawals</p>
        </div>
      </div>
      {network !== 'mainnet' && (
        <p className="notice info">
          {sandbox
            ? 'Test balance only. No real tokens move.'
            : 'Solana devnet. Test USDC has no financial value.'}
        </p>
      )}
      {!walletAddress ? (
        <div className="studio-section">
          <h2>Connect wallet to add funds</h2>
          <p>Deposits and withdrawals use your verified Solana wallet.</p>
          <Link
            href={`/creator/account${returnTo ? `?returnTo=${encodeURIComponent(`/creator/balance?returnTo=${encodeURIComponent(returnTo)}`)}` : ''}`}
            className="button"
          >
            Connect wallet
          </Link>
        </div>
      ) : (
        <section className="studio-section studio-money-form">
          <div className="studio-tabs">
            <button
              aria-pressed={action === 'deposit'}
              onClick={() => {
                setAction('deposit');
                setMessage('');
              }}
            >
              Deposit
            </button>
            <button
              aria-pressed={action === 'withdraw'}
              onClick={() => {
                setAction('withdraw');
                setMessage('');
              }}
            >
              Withdraw
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="field">
              Amount (USDC)
              <input
                value={amount}
                inputMode="decimal"
                required
                onChange={(e) => {
                  setAmount(e.target.value);
                  setWithdrawalKey('');
                }}
              />
            </label>
            <p className="small-print">
              {action === 'deposit'
                ? 'Your wallet signs deposit. Balance updates after finalized confirmation. A small SOL balance covers network fees.'
                : 'Operator reviews request and sends USDC to your verified wallet. Pending amount stays reserved.'}
            </p>
            <button
              className="button"
              disabled={busy || (action === 'deposit' ? !depositReady : !ready)}
            >
              {busy
                ? 'Processing…'
                : action === 'deposit'
                  ? sandbox
                    ? 'Add test USDC'
                    : 'Deposit USDC'
                  : 'Request withdrawal'}
            </button>
          </form>
        </section>
      )}
      {!ready && (
        <p className="notice">
          Funding is not configured yet. Your balance and history remain available.
        </p>
      )}
      {ready && !depositReady && action === 'deposit' && (
        <p className="notice">
          Deposits paused until pricing and live tracking are ready. Withdrawals remain available.
        </p>
      )}
      {pending && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await verify(pending.id, pending.signature);
            } catch (e) {
              setMessage(e instanceof Error ? e.message : 'Waiting for finalization.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Check deposit confirmation
        </button>
      )}
      {message && (
        <p className="message" role="status">
          {message}
        </p>
      )}
      <section className="studio-section">
        <h2>Transfers</h2>
        {!view.transfers.length && <p>Deposits, rewards, and withdrawals will appear here.</p>}
        {view.transfers.map((t) => (
          <div className="studio-history-row" key={t.id}>
            <div>
              <strong>
                {t.kind === 'DEPOSIT'
                  ? 'Deposit'
                  : t.kind === 'REWARD'
                    ? 'Raider reward'
                    : 'Withdrawal'}
              </strong>
              <p>
                {new Date(t.createdAt).toLocaleDateString('en')} ·{' '}
                {t.status === 'PAID'
                  ? 'Completed'
                  : t.status === 'REJECTED'
                    ? 'Rejected'
                    : t.kind === 'DEPOSIT'
                      ? 'Awaiting transfer'
                      : 'Operator review pending'}
              </p>
              {t.signature && t.network !== 'sandbox' && (
                <a
                  className="inline-link"
                  href={`https://solscan.io/tx/${t.signature}${t.network === 'devnet' ? '?cluster=devnet' : ''}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Receipt
                </a>
              )}
              {t.kind === 'DEPOSIT' && t.status === 'AWAITING_TRANSFER' && !sandbox && (
                <DepositRecovery id={t.id} onVerified={() => router.refresh()} />
              )}
            </div>
            <strong>{formatUsdc(t.amount)} USDC</strong>
          </div>
        ))}
      </section>
      <section className="studio-section">
        <h2>Balance activity</h2>
        {!view.entries.length && <p>No balance activity yet.</p>}
        {view.entries.map((e) => (
          <div key={e.id} className="studio-history-row">
            <div>
              <strong>{e.kind.replaceAll('_', ' ').toLowerCase()}</strong>
              <p>
                {new Date(e.createdAt).toLocaleDateString('en')}
                {e.raidId && (
                  <>
                    {' '}
                    ·{' '}
                    <Link className="inline-link" href={`/creator/raids/${e.raidId}`}>
                      Raid details
                    </Link>
                  </>
                )}
              </p>
            </div>
            <div>
              <span>{formatUsdc(e.availableDelta)} USDC available</span>
              {BigInt(e.reservedDelta) !== 0n && <p>{formatUsdc(e.reservedDelta)} USDC reserved</p>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
function DepositRecovery({ id, onVerified }: { id: string; onVerified: () => void }) {
  const [signature, setSignature] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="studio-recovery"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const response = await fetch('/api/balance/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, signature }),
          });
          const body = await response.json();
          if (!response.ok) throw Error(body.error);
          setMessage('Deposit verified.');
          onVerified();
        } catch (err) {
          setMessage(err instanceof Error ? err.message : 'Verification failed.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        aria-label="Deposit transaction signature"
        placeholder="Already sent? Paste transaction signature"
        required
        value={signature}
        onChange={(e) => setSignature(e.target.value)}
      />
      <button className="button secondary small" disabled={busy}>
        Verify
      </button>
      <p role="status">{message}</p>
    </form>
  );
}
