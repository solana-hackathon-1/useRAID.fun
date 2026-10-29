'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { oauthMessage } from '@/lib/oauth-messages';

export function XConnection({
  account,
  status,
  returnTo,
  demo = false,
}: {
  account?: { username: string; displayName: string; profileImage: string | null } | null;
  status?: string;
  /** An X sign-in return token from the server-side allowlist, such as `account`. */
  returnTo?: string;
  demo?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const statusMessage = oauthMessage(status);
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
              loading="lazy"
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
      ) : demo ? (
        <button className="button" disabled>
          Connect X
        </button>
      ) : (
        <a
          className="button"
          href={returnTo ? `/api/auth/x?return=${encodeURIComponent(returnTo)}` : '/api/auth/x'}
        >
          Connect X
        </a>
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
