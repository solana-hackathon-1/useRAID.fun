'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export function AdminAction({
  action,
  id,
  label,
  values,
  url,
}: {
  url?: string;
  action: string;
  id: string;
  label: string;
  values: Record<string, unknown>;
}) {
  const router = useRouter();
  const [reason, setReason] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await fetch(url || `/api/admin/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, ...values, reason }),
          });
          const b = await r.json();
          if (!r.ok) throw Error(b.error);
          setReason('');
          setMessage('Saved.');
          router.refresh();
        } catch (e) {
          setMessage(e instanceof Error ? e.message : 'Unable to save.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <input
          aria-label={`Reason: ${label}`}
          placeholder="Reason for audit log"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          maxLength={500}
        />
      </label>
      <button className="button secondary" disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
      {message && (
        <p className="message" role="status">
          {message}
        </p>
      )}
    </form>
  );
}
export function SettingsForm({
  settings,
}: {
  settings: {
    collectionEnabled: boolean;
    maxActiveRaids: number;
    monthlyBudgetCents: number;
    cutoffCents: number;
    dailyRequestLimit: number;
    identityDailyLimit: number;
  };
}) {
  const router = useRouter();
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const d = new FormData(e.currentTarget);
        setBusy(true);
        try {
          const r = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              collectionEnabled: d.get('collectionEnabled') === 'on',
              maxActiveRaids: Number(d.get('maxActiveRaids')),
              monthlyBudgetCents: Number(d.get('monthlyBudgetCents')),
              cutoffCents: Number(d.get('cutoffCents')),
              dailyRequestLimit: Number(d.get('dailyRequestLimit')),
              identityDailyLimit: Number(d.get('identityDailyLimit')),
              reason: d.get('reason'),
            }),
          });
          const b = await r.json();
          if (!r.ok) throw Error(b.error);
          setMessage('Settings saved.');
          router.refresh();
        } catch (e) {
          setMessage(e instanceof Error ? e.message : 'Unable to save settings.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="stack">
        <label className="checkbox">
          <input
            type="checkbox"
            name="collectionEnabled"
            defaultChecked={settings.collectionEnabled}
          />{' '}
          Enable X collection (kill switch)
        </label>
        <div className="form-grid">
          {[
            { key: 'maxActiveRaids', label: 'Campaign slots', max: 10 },
            { key: 'monthlyBudgetCents', label: 'X budget (cents)', max: 20000 },
            { key: 'cutoffCents', label: 'Collection cutoff (cents)', max: 19000 },
            { key: 'dailyRequestLimit', label: 'Daily request limit', max: 5000 },
            { key: 'identityDailyLimit', label: 'Daily sign-in limit', max: 20000 },
          ].map((f) => (
            <label className="field" key={f.key}>
              {f.label}
              <input
                type="number"
                name={f.key}
                defaultValue={settings[f.key as keyof typeof settings] as number}
                min={1}
                max={f.max}
                required
              />
            </label>
          ))}
        </div>
        <label className="field">
          Change reason
          <input name="reason" required maxLength={500} />
        </label>
        <button className="button" disabled={busy}>
          {busy ? 'Saving…' : 'Save operating limits'}
        </button>
        <p className="message" role="status">
          {message}
        </p>
      </div>
    </form>
  );
}
