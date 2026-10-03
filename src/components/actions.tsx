'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Radio } from 'lucide-react';
import { track } from './refresh';
export function ExternalActions({
  compose,
  raidId,
  demo,
  active = true,
}: {
  compose: string;
  raidId: string;
  demo: boolean;
  active?: boolean;
}) {
  return (
    <div className="detail-actions">
      {demo ? (
        <>
          <button className="button" disabled title="Example campaign; posting disabled">
            <Radio size={16} />
            Raid on X
          </button>
        </>
      ) : (
        <>
          {active && (
            <a
              className="button"
              href={compose}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('raid_click', raidId)}
            >
              <Radio size={16} />
              Raid on X
            </a>
          )}
        </>
      )}
    </div>
  );
}
export function SubmitPost({
  id,
  demo,
  ruleVersion = 1,
  officialHandle = 'useRAID',
}: {
  id: string;
  demo: boolean;
  ruleVersion?: number;
  officialHandle?: string;
}) {
  const [url, setUrl] = useState(''),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setMessage('');
        try {
          const r = await fetch(`/api/raids/${id}/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          });
          const b = await r.json();
          setError(!r.ok);
          setMessage(b.message || b.error);
        } catch {
          setError(true);
          setMessage('Could not queue this post. Try again.');
        } finally {
          setPending(false);
        }
      }}
    >
      <label className="field">
        Missing your post?
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://x.com/you/status/…"
          required
          disabled={demo}
        />
        <small>
          {ruleVersion >= 3
            ? `We’ll check its author, @${officialHandle} mention, and posting time.`
            : 'We’ll check its mention, raid tag, and posting time.'}
        </small>
      </label>
      <div className="form-actions">
        <button className="button secondary" disabled={demo || pending}>
          {pending ? 'Queuing…' : 'Submit post URL'}
        </button>
      </div>
      {message && (
        <p role="status" className={`message ${error ? 'error' : ''}`}>
          {message}
        </p>
      )}
    </form>
  );
}
export function MutationButton({
  url,
  body,
  children,
  secondary = true,
}: {
  url: string;
  body: unknown;
  children: React.ReactNode;
  secondary?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <>
      <button
        disabled={busy}
        className={`button ${secondary ? 'secondary' : ''}`}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const r = await fetch(url, {
              method: url.startsWith('/api/raids/') ? 'PATCH' : 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const b = await r.json();
            if (!r.ok) throw Error(b.error);
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Request failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Saving…' : children}
      </button>
      {error && (
        <p role="alert" className="message error">
          {error}
        </p>
      )}
    </>
  );
}
