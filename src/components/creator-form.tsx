'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export function CreatorForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fields = Object.fromEntries(new FormData(form));
        setBusy(true);
        setMessage('');
        try {
          const r = await fetch('/api/raids', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...fields,
              startsAt: fields.startsAt
                ? new Date(String(fields.startsAt)).toISOString()
                : undefined,
            }),
          });
          const b = await r.json();
          if (!r.ok) throw Error(b.error);
          setError(false);
          setMessage('Draft saved. Launch it from your campaigns when you’re ready.');
          form.reset();
          router.refresh();
        } catch (e) {
          setError(true);
          setMessage(e instanceof Error ? e.message : 'Unable to save draft.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <label className="field full">
          Campaign title
          <input
            name="title"
            required
            minLength={5}
            maxLength={120}
            placeholder="What’s your community talking about?"
          />
        </label>
        <label className="field full">
          Description
          <textarea
            name="description"
            required
            minLength={20}
            maxLength={2000}
            placeholder="Give people context and a reason to participate."
          />
        </label>
        <label className="field full">
          Solana token mint
          <input name="mint" required placeholder="Exact base58 mint address" />
        </label>
        <label className="field">
          Token symbol
          <input name="symbol" required maxLength={15} placeholder="BONK" />
        </label>
        <label className="field">
          Token name
          <input name="name" required maxLength={80} placeholder="Bonk" />
        </label>
        <label className="field">
          Start time (optional)
          <input name="startsAt" type="datetime-local" />
          <small>Your local timezone. Leave blank to launch immediately.</small>
        </label>
        <label className="field">
          Duration (hours)
          <input name="duration" type="number" min={1} max={72} defaultValue={24} required />
        </label>
      </div>
      <div className="form-actions">
        <button className="button" disabled={busy}>
          {busy ? 'Saving…' : 'Save draft'}
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          Drafts are private until launched.
        </span>
      </div>
      {message && (
        <p role="status" className={`message ${error ? 'error' : ''}`}>
          {message}
        </p>
      )}
    </form>
  );
}
export function AffiliationForm({ initial }: { initial: string }) {
  const [message, setMessage] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const affiliation = new FormData(e.currentTarget).get('affiliation');
        try {
          const r = await fetch('/api/creator', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ affiliation }),
          });
          const b = await r.json();
          setMessage(r.ok ? 'Affiliation submitted for administrator review.' : b.error);
        } catch {
          setMessage('Unable to submit. Try again.');
        }
      }}
    >
      <label className="field">
        Project affiliation
        <textarea
          name="affiliation"
          defaultValue={initial}
          minLength={20}
          maxLength={1000}
          required
          placeholder="Your project, role, official website, and evidence of affiliation."
        />
      </label>
      <div className="form-actions">
        <button className="button">Request creator approval</button>
      </div>
      <p className="message" role="status">
        {message}
      </p>
    </form>
  );
}
