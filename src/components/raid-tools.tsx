'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { track } from './refresh';
import { formatNumber } from '@/lib/format';
export function RaidShare({
  id,
  demo,
  trackView = true,
}: {
  id: string;
  demo: boolean;
  trackView?: boolean;
}) {
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!demo && trackView) track('raid_view', id);
  }, [id, demo, trackView]);
  return (
    <div className="form-actions">
      <button
        className="button secondary"
        onClick={async () => {
          const url = `${window.location.origin}/raids/${id}`;
          try {
            await navigator.clipboard.writeText(url);
            setMessage('Raid link copied.');
            if (!demo) track('share_click', id);
          } catch {
            setMessage(url);
          }
        }}
      >
        Copy Raid link
      </button>
      {!demo && (
        <a className="button secondary" href={`/api/raids/${id}/report`}>
          Download campaign report
        </a>
      )}
      <span role="status">{message}</span>
    </div>
  );
}
export function CreatorRaidTools({
  id,
  funding,
  canEdit,
}: {
  id: string;
  canEdit: boolean;
  funding: {
    required: boolean;
    verified: boolean;
    lamports: string | null;
    recipient: string | null;
    target: number | null;
  };
}) {
  const router = useRouter();
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(path: string, data: Record<string, FormDataEntryValue>) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/raids/${id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed.');
      setMessage(
        path === 'fund' ? 'Funding verified. You can launch this Raid.' : 'Campaign post added.',
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {funding.required && (
        <p>
          Target: {formatNumber(funding.target)} observed impressions · Funding:{' '}
          {funding.verified ? 'Verified' : 'Required'}
        </p>
      )}
      {funding.required &&
        !funding.verified &&
        (funding.lamports && funding.recipient ? (
          <>
            <p>
              Funding quote: {Number(funding.lamports) / 1e9} SOL. Send from your verified wallet
              with memo <code>useRAID:{id}</code>.
            </p>
            <p className="mint">Recipient: {funding.recipient}</p>
            <p className="small-print">
              Impressions are not guaranteed. If duration expires first, the report shows target
              missed. Payment and refund terms must be agreed before sending funds.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit('fund', Object.fromEntries(new FormData(e.currentTarget)));
              }}
            >
              <label className="field">
                Finalized funding transaction signature
                <input name="signature" required maxLength={90} />
              </label>
              <button className="button secondary" disabled={busy}>
                Verify funding
              </button>
            </form>
          </>
        ) : (
          <p>
            Funding price and receiving wallet are not configured. Draft saved; do not send funds
            yet.
          </p>
        ))}
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit('brief', Object.fromEntries(new FormData(e.currentTarget)));
          }}
        >
          <label className="field">
            Add a campaign post
            <input
              name="url"
              type="url"
              required
              placeholder="https://x.com/yourproject/status/…"
            />
          </label>
          <p className="small-print">
            Campaign posts give raiders context. Only verified, qualifying participant posts count
            toward impressions.
          </p>
          <button className="button secondary" disabled={busy}>
            Add post
          </button>
        </form>
      )}
      <p role="status">{message}</p>
    </div>
  );
}
export function AdminPaymentForm({ id }: { id: string }) {
  const router = useRouter();
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setMessage('');
        const signature = String(new FormData(event.currentTarget).get('signature') || '');
        try {
          const response = await fetch('/api/admin/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, signature }),
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Payment verification failed.');
          setMessage('Finalized payment verified.');
          router.refresh();
        } catch (error) {
          setMessage(error instanceof Error ? error.message : 'Payment verification failed.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        Finalized payment signature
        <input name="signature" required maxLength={90} />
      </label>
      <button className="button secondary" disabled={busy}>
        Verify payout
      </button>
      <p role="status">{message}</p>
    </form>
  );
}
