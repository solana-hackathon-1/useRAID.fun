'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export function UsdcPaymentForm({
  id,
  withdrawal,
  sandbox,
  late = false,
}: {
  id: string;
  withdrawal: boolean;
  sandbox: boolean;
  late?: boolean;
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function submit(body: unknown) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/admin/usdc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      if (!response.ok) throw Error(value.error);
      setMessage('Recorded.');
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Unable to verify.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void submit(
            late
              ? {
                  id,
                  action: 'verify-late',
                  signature: f.get('signature'),
                  reason: f.get('reason'),
                }
              : { id, action: 'verify', signature: f.get('signature') },
          );
        }}
      >
        <label className="field">
          Finalized USDC transfer signature
          <input name="signature" required defaultValue={sandbox ? `sandbox:${id}` : ''} />
        </label>
        {late && (
          <label className="field">
            Reason for crediting after expiry
            <input required name="reason" minLength={5} maxLength={500} />
          </label>
        )}
        <button className="button secondary small" disabled={busy}>
          {late
            ? 'Credit late deposit'
            : sandbox
              ? 'Confirm test payment'
              : 'Verify payment receipt'}
        </button>
      </form>
      {withdrawal && (
        <details>
          <summary>Reject unpaid withdrawal</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit({
                id,
                action: 'reject',
                reason: new FormData(e.currentTarget).get('reason'),
              });
            }}
          >
            <label className="field">
              Reason
              <input required name="reason" minLength={5} maxLength={500} />
            </label>
            <button className="button secondary small" disabled={busy}>
              Reject & release funds
            </button>
          </form>
        </details>
      )}
      <p role="status">{message}</p>
    </div>
  );
}
