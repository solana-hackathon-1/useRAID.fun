'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export function SandboxControls({ raidId }: { raidId?: string }) {
  const router = useRouter(),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  async function run(action: string) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/studio/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, raidId }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error);
      if (!raidId) router.push('/creator');
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Test failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="studio-section">
      <h2>Local test controls</h2>
      <p>Isolated database. Fake X posts and USDC; no real account connection or money transfer.</p>
      {!raidId ? (
        <button className="button" disabled={busy} onClick={() => void run('login')}>
          Enter test Creator Studio
        </button>
      ) : (
        <div className="form-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void run('contribute')}
          >
            Simulate contributor
          </button>
          <button className="button secondary" disabled={busy} onClick={() => void run('complete')}>
            Reach target & finish test review
          </button>
        </div>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
