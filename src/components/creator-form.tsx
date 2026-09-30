'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
export function CreatorForm({ rate = null }: { rate?: number | null }) {
  const router = useRouter();
  const [projectType, setProjectType] = useState('');
  const [target, setTarget] = useState(10000);
  const [expectedPosts, setExpectedPosts] = useState(20);
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
              projectType,
              fundingTermsAccepted:
                projectType === 'PROJECT' ? fields.fundingTermsAccepted === 'on' : undefined,
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
          setProjectType('');
          router.refresh();
        } catch (e) {
          setError(true);
          setMessage(e instanceof Error ? e.message : 'Unable to save draft.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="form-section">
        <legend>Does your project have a token?</legend>
        <label className="field">
          Project type
          <select required value={projectType} onChange={(e) => setProjectType(e.target.value)}>
            <option value="">Choose your project type</option>
            <option value="TOKEN">Yes — existing Solana token</option>
            <option value="PROJECT">No — project without a token</option>
          </select>
          <small>
            Token projects receive discovery priority. Non-token projects must fund their Raid
            before launch.
          </small>
        </label>
      </fieldset>
      <fieldset className="form-section">
        <legend>Campaign information</legend>
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
        </div>
      </fieldset>
      <fieldset className="form-section">
        <legend>Project identity</legend>
        <div className="form-grid">
          <label className="field full">
            {projectType === 'TOKEN' ? 'Solana token mint' : 'Token mint (not needed)'}
            <input
              name="mint"
              required={projectType === 'TOKEN'}
              disabled={projectType !== 'TOKEN'}
              placeholder="Exact base58 mint address"
            />
          </label>
          <label className="field">
            Project symbol
            <input name="symbol" required maxLength={15} placeholder="BONK" />
          </label>
          <label className="field">
            Project name
            <input name="name" required maxLength={80} placeholder="Bonk" />
          </label>
        </div>
      </fieldset>
      <fieldset className="form-section">
        <legend>Scheduling</legend>
        <div className="form-grid">
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
      </fieldset>
      {projectType === 'PROJECT' && (
        <fieldset className="form-section">
          <legend>Fund your Raid</legend>
          <label className="field">
            Impression target
            <input
              type="number"
              name="impressionTarget"
              min={1000}
              max={1000000000}
              step={1000}
              required
              value={target}
              onChange={(e) => setTarget(Number(e.target.value))}
            />
          </label>
          <p>
            {rate
              ? `Estimated funding: ${Math.ceil((target * rate) / 1000) / 1e9} SOL at ${rate / 1e9} SOL per 1,000 impressions.`
              : 'Funding calculator awaits campaign pricing. You can save your target now.'}
          </p>
          <label className="field">
            Expected qualifying posts (planning only)
            <input
              type="number"
              min={1}
              max={10000}
              value={expectedPosts}
              onChange={(e) => setExpectedPosts(Number(e.target.value))}
            />
          </label>
          {rate && expectedPosts > 0 && (
            <p>
              Estimated content CPA:{' '}
              {(Math.ceil((target * rate) / 1000) / 1e9 / expectedPosts).toFixed(5)} SOL per
              qualifying original post. Actual CPA depends on reviewed results.
            </p>
          )}
          <p className="small-print">
            Ends when qualifying posts reach the target or campaign duration expires. Views are
            observed impressions, not unique people. Delivery is not guaranteed.
          </p>
          <label className="field">
            <input name="fundingTermsAccepted" type="checkbox" required /> I accept that verified
            creator funding is held by the platform. After final results and review, verified
            participant views earn a proportional share up to the target; any unearned balance
            returns to my verified funding wallet. No delivery guarantee or platform fee in this
            pilot.
          </label>
          <p>
            Tell us your funding budget and purpose. Save your draft to request funding
            arrangements. Launch stays locked until funding is verified; no payment is collected
            here.
          </p>
          <label className="field">
            Funding request
            <textarea
              name="fundingRequest"
              required
              minLength={20}
              maxLength={2000}
              placeholder="Budget, currency, and what the funding should cover"
            />
          </label>
        </fieldset>
      )}
      <div className="form-actions">
        <button className="button" disabled={busy || !projectType}>
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
