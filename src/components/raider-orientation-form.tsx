'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  SaveRaiderOrientationInputSchema,
  SavedOrientationSchema,
} from '../raider-onboarding/storage-contracts';
import { OrientationStateSchema, type OrientationState } from '../raider-onboarding/host-contracts';
import type { RaiderOrientationInput } from '../raider-onboarding';

type SaveInput = { expectedRevision: number; preferences: RaiderOrientationInput };
export type OrientationTransport = {
  save(input: SaveInput, key: string): Promise<Response>;
  read(): Promise<Response>;
};
const transport: OrientationTransport = {
  save: (input, key) =>
    fetch('/api/v1/me/orientation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(input),
    }),
  read: () => fetch('/api/v1/me/orientation', { cache: 'no-store' }),
};
const initial = (state: OrientationState) => ({
  experience: state.orientation?.preferences.experience ?? 'BEGINNER',
  workInterests: state.orientation?.preferences.workInterests ?? [],
  timezone: state.orientation?.preferences.timezone ?? 'UTC',
  orientationAcknowledged: !!state.orientation,
  evidencePath: state.orientation?.preferences.evidencePath ?? 'PORTFOLIO',
  portfolioUrl: state.orientation?.preferences.portfolioUrl ?? '',
});
export function RaiderOrientationForm({
  state: initialState,
  api = transport,
  browseLink,
}: {
  state: OrientationState;
  api?: OrientationTransport;
  browseLink?: ReactNode;
}) {
  const [state, setState] = useState(initialState);
  const [draft, setDraft] = useState(() => initial(initialState));
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [needsRevision, setNeedsRevision] = useState(false);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState('');
  const pending = useRef<{ key: string; input: SaveInput } | null>(null);
  const inFlight = useRef(false);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);
  function problem(text: string) {
    setMessage(text);
  }
  function update(patch: Partial<typeof draft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setMessage('');
    setSaved('');
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!pending.current) {
      const parsed = SaveRaiderOrientationInputSchema.safeParse({
        expectedRevision: state.orientation?.revision ?? 0,
        preferences: {
          experience: draft.experience,
          workInterests: draft.workInterests,
          timezone: draft.timezone,
          orientationAcknowledged: draft.orientationAcknowledged,
          evidencePath: draft.experience === 'EXPERIENCED' ? draft.evidencePath : undefined,
          portfolioUrl: draft.portfolioUrl.trim() || null,
        },
      });
      if (!parsed.success) {
        problem(
          'Choose a work interest, enter a valid timezone and acknowledge the commitments. Portfolio links must use HTTP or HTTPS.',
        );
        return;
      }
      pending.current = { key: crypto.randomUUID(), input: parsed.data };
    }
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    setSaved('');
    try {
      const attempt = pending.current;
      const response = await api.save(attempt.input, attempt.key);
      const body = await response.json();
      if (!response.ok) {
        const code = body?.error?.code;
        if (response.status >= 400 && response.status < 500) {
          pending.current = null;
          setUncertain(false);
          if (code === 'REVISION_CHANGED' || code === 'IDEMPOTENCY_KEY_REUSED') {
            setNeedsRevision(true);
            problem(
              'Saved preferences changed. Reload the saved revision, then review your draft before saving.',
            );
          } else
            problem(
              response.status === 401
                ? 'Sign in again to save your draft.'
                : response.status === 403
                  ? 'Saving is not permitted for this account.'
                  : response.status === 429
                    ? 'Too many requests. Wait, then save your draft again.'
                    : 'Check your preferences and try again.',
            );
        } else {
          setUncertain(true);
          problem('The save could not be confirmed. Retry with the same draft.');
        }
        return;
      }
      const parsed = SavedOrientationSchema.safeParse(body?.orientation);
      if (!parsed.success) throw Error('Invalid saved response');
      setState((s) => ({ ...s, orientation: parsed.data }));
      pending.current = null;
      setUncertain(false);
      setNeedsRevision(false);
      setSaved('Preferences saved.');
    } catch {
      setUncertain(true);
      problem('The save could not be confirmed. Retry with the same draft.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function reloadRevision() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const response = await api.read();
      const body = await response.json();
      const parsed = OrientationStateSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw Error('Read failed');
      setState(parsed.data);
      pending.current = null;
      setUncertain(false);
      setNeedsRevision(false);
      setSaved('Saved revision reloaded. Your draft is preserved.');
    } catch {
      problem('Could not reload saved preferences. Your draft is preserved.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const retired = draft.workInterests.filter((id) => !state.catalog.some((item) => item.id === id));
  return (
    <div className="orientation-layout">
      <section className="orientation-card">
        <h2>Before you commit</h2>
        <ul>
          <li>
            One active work engagement applies across Guilds, wallets, Parties and Challenges.
            Unpaid orientation and practice do not reserve a work slot.
          </li>
          <li>
            Interests and portfolio links describe your experience. Relevant evidence and assessment
            establish verified skills.
          </li>
          <li>
            Review exact scope, deadlines, permitted tools and evidence before accepting work.
            Submission and review are separate steps; revisions may keep the work active.
          </li>
          <li>
            Verify your payout destination before paid commitment. Payment needs verified funding,
            binding and an authorized outcome. Saving preferences starts no work or payment.
          </li>
          <li>
            Private briefs and code require explicit scoped permission. Keep confidential material
            out of portfolio links and public posts.
          </li>
          <li>
            Raise a review or payment disagreement through its agreed dispute process; silence does
            not decide entitlement.
          </li>
        </ul>
      </section>
      <section className="orientation-card">
        <h2>Your private preferences</h2>
        <p>These preferences stay in your account. No verified rank is assigned.</p>
        {!state.writesAvailable && (
          <p role="status">
            Saving preferences is currently unavailable. Your existing saved preferences remain
            visible.
          </p>
        )}
        <form onSubmit={submit} aria-busy={busy}>
          <fieldset
            disabled={busy || uncertain || !state.writesAvailable}
            className="orientation-fields"
          >
            <legend className="visually-hidden">Orientation preferences</legend>
            <label>
              Experience
              <select
                aria-label="Experience"
                value={draft.experience}
                onChange={(e) =>
                  update({ experience: e.target.value as 'BEGINNER' | 'EXPERIENCED' })
                }
              >
                <option value="BEGINNER">Getting started</option>
                <option value="EXPERIENCED">Experienced builder</option>
              </select>
            </label>
            <fieldset className="orientation-interests">
              <legend>Work interests</legend>
              {state.catalog.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={draft.workInterests.includes(item.id)}
                    onChange={(e) =>
                      update({
                        workInterests: e.target.checked
                          ? [...draft.workInterests, item.id]
                          : draft.workInterests.filter((id) => id !== item.id),
                      })
                    }
                  />
                  {item.label}
                </label>
              ))}
              {retired.length > 0 && (
                <p>
                  Some saved interests are no longer offered.{' '}
                  <button
                    type="button"
                    onClick={() =>
                      update({
                        workInterests: draft.workInterests.filter((id) => !retired.includes(id)),
                      })
                    }
                  >
                    Remove retired interests from draft
                  </button>
                </p>
              )}
            </fieldset>
            <label>
              Timezone
              <input
                aria-label="Timezone"
                value={draft.timezone}
                required
                maxLength={80}
                placeholder="Asia/Kathmandu"
                onChange={(e) => update({ timezone: e.target.value })}
              />
              <span className="orientation-hint">
                Use an IANA timezone, such as Asia/Kathmandu or UTC.
              </span>
            </label>
            {draft.experience === 'EXPERIENCED' && (
              <>
                <label>
                  Evidence path
                  <select
                    aria-label="Evidence path"
                    value={draft.evidencePath}
                    onChange={(e) =>
                      update({ evidencePath: e.target.value as 'PORTFOLIO' | 'TRIAL' })
                    }
                  >
                    <option value="PORTFOLIO">Portfolio</option>
                    <option value="TRIAL">Relevant skill trial</option>
                  </select>
                </label>
                <label id="portfolio">
                  Portfolio URL (optional)
                  <input
                    type="url"
                    aria-label="Portfolio URL (optional)"
                    maxLength={2048}
                    value={draft.portfolioUrl}
                    onChange={(e) => update({ portfolioUrl: e.target.value })}
                  />
                </label>
                <p className="orientation-hint">
                  A saved link is self-described evidence. It has not been assessed or verified.
                </p>
              </>
            )}
            <label className="orientation-ack">
              <input
                type="checkbox"
                required
                checked={draft.orientationAcknowledged}
                onChange={(e) => update({ orientationAcknowledged: e.target.checked })}
              />
              I understand these commitments
            </label>
          </fieldset>
          {message && (
            <p role="alert" ref={alert} tabIndex={-1}>
              {message}
            </p>
          )}
          {saved && <p role="status">{saved}</p>}
          <div className="orientation-actions">
            <button
              className="button"
              type="submit"
              disabled={busy || needsRevision || (!state.writesAvailable && !uncertain)}
            >
              {busy ? 'Saving…' : uncertain ? 'Retry save' : 'Save preferences'}
            </button>
            {needsRevision && (
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => void reloadRevision()}
              >
                Reload saved revision
              </button>
            )}
          </div>
        </form>
      </section>
      {state.orientation && (
        <section className="orientation-card">
          <h2>Next steps</h2>
          <p>
            {state.orientation.preferences.experience === 'BEGINNER'
              ? 'Starter tasks are not available yet.'
              : state.orientation.preferences.evidencePath === 'TRIAL'
                ? 'Skill trials are not available yet.'
                : 'Portfolio assessment is not available yet.'}
          </p>
          <p>
            Your preferences are recorded. Relevant starter work, assessment and paid-work
            eligibility will require their own checks.
          </p>
          {browseLink}
        </section>
      )}
    </div>
  );
}
