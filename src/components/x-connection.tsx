'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const messages: Record<string, string> = {
  connected: 'X account connected.',
  cancelled: 'X authorization was cancelled. You can try again.',
  state: 'Authorization expired or was invalid. Start Connect X again.',
  session: 'Your sign-in session changed or expired. Start Connect X again.',
  identity:
    'This X identity cannot be linked to this account. Reconnect using your original X account.',
  suspended: 'This account is suspended.',
  provider: 'X could not complete authorization or profile lookup. Try again later.',
  unavailable: 'X connection is unavailable. Check OAuth configuration and demo mode.',
  failed: 'Could not connect X. Try again later.',
};
export function XConnection({
  account,
  status,
  demo = false,
}: {
  account?: { username: string; displayName: string; profileImage: string | null } | null;
  status?: string;
  demo?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const statusMessage = status && Object.hasOwn(messages, status) ? messages[status] : '';
  return (
    <section className="panel" aria-label="X account connection">
      <h2>{account ? 'X Connected' : 'Connect your X account'}</h2>
      {account && (
        <div className="account-profile">
          {account.profileImage && (
            <img
              src={account.profileImage}
              alt=""
              width={48}
              height={48}
              referrerPolicy="no-referrer"
            />
          )}
          <p>
            {account.displayName} · @{account.username}
          </p>
        </div>
      )}
      {account ? (
        <>
          <button
            className="button secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const response = await fetch('/api/auth/x/disconnect', { method: 'POST' });
                if (!response.ok) throw new Error('Could not disconnect X. Try again.');
                router.replace('/creator');
                router.refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not disconnect X.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
          <p className="small-print">
            Disconnect removes your active connection. Your X sign-in identity stays saved so you
            can access this account and its raid history again.
          </p>
        </>
      ) : (
        demo ? (
          <button className="button" disabled>
            Connect X
          </button>
        ) : (
          <a className="button" href="/api/auth/x">
            Connect X
          </a>
        )
      )}
      {demo && <p className="notice info">X connection is disabled in this read-only preview.</p>}
      {(error || statusMessage) && (
        <p role={error || status !== 'connected' ? 'alert' : 'status'} className="notice">
          {error || statusMessage}
        </p>
      )}
    </section>
  );
}
