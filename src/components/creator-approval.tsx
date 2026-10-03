'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function CreatorApproval({ initial }: { initial: string }) {
  const router = useRouter();
  const [submitted, setSubmitted] = useState(!!initial);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  return (
    <section className="panel creator-approval" aria-labelledby="creator-approval-heading">
      <h2 id="creator-approval-heading">Creator approval required</h2>
      <p>
        Creator access is approved by an administrator during the pilot. Describe your project and
        your role, then request approval. You can save drafts after approval, and funded Raids
        launch from your balance.
      </p>
      {submitted && (
        <p className="notice info" role="status">
          Your request is awaiting administrator review. You can update it below.
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const affiliation = new FormData(e.currentTarget).get('affiliation');
          setBusy(true);
          setMessage('');
          try {
            const response = await fetch('/api/creator', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ affiliation }),
            });
            const body = await response.json();
            setError(!response.ok);
            setMessage(response.ok ? 'Request submitted for administrator review.' : body.error);
            if (response.ok) setSubmitted(true);
            else if (response.status === 409) router.refresh();
          } catch {
            setError(true);
            setMessage('Unable to submit. Try again.');
          } finally {
            setBusy(false);
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
            placeholder="Your project, role, official website, token contract address, and evidence of affiliation, e.g. an official post from the project account."
          />
        </label>
        <div className="form-actions">
          <button className="button" disabled={busy}>
            {submitted ? 'Update request' : 'Request creator approval'}
          </button>
        </div>
        {message && (
          <p role="status" className={`message ${error ? 'error' : ''}`}>
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
