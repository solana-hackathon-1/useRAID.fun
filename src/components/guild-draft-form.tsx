'use client';
import { useEffect, useRef, useState } from 'react';
import { SaveGuildDraftInputSchema } from '../guild-profiles/draft-storage-contracts';
import {
  GuildDraftHttpSavedSchema,
  GuildDraftHttpStateSchema,
  type GuildDraftFormState,
} from '../guild-profiles/http-contracts';
import type { z } from 'zod';
type SaveInput = z.infer<typeof SaveGuildDraftInputSchema>;
export interface GuildDraftTransport {
  save(input: SaveInput, key: string): Promise<Response>;
  read(id: string): Promise<Response>;
}
const transport: GuildDraftTransport = {
  save: (input, key) =>
    fetch('/api/v1/guild-drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(input),
    }),
  read: (id) => fetch('/api/v1/guild-drafts/' + encodeURIComponent(id), { cache: 'no-store' }),
};
export function GuildDraftForm({
  state: initialState,
  api = transport,
  draftLinkPrefix = '/creator/guild-drafts/',
}: {
  state: GuildDraftFormState;
  api?: GuildDraftTransport;
  draftLinkPrefix?: string;
}) {
  const [state, setState] = useState(initialState),
    [draft, setDraft] = useState(
      initialState.draft?.profile ?? { name: '', slug: '', description: '' },
    );
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [needsRevision, setNeedsRevision] = useState(false),
    [message, setMessage] = useState(''),
    [saved, setSaved] = useState('');
  const pending = useRef<{ key: string; input: SaveInput; unconfirmed: boolean } | null>(null),
    inFlight = useRef(false),
    alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);
  function update(field: 'name' | 'slug' | 'description', value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
    setMessage('');
    setSaved('');
  }
  function unknown() {
    if (pending.current) pending.current.unconfirmed = true;
    setUncertain(true);
    setMessage('The save could not be confirmed. Keep this page open. Retry with the same draft.');
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!pending.current) {
      const parsed = SaveGuildDraftInputSchema.safeParse({
        guildDraftId: state.draft?.id ?? null,
        expectedRevision: state.draft?.revision ?? 0,
        profile: draft,
      });
      if (!parsed.success) {
        setMessage(
          'Enter a Guild name and a draft URL using lowercase letters, numbers and single hyphens. Description must be at most 4000 characters.',
        );
        return;
      }
      pending.current = { key: crypto.randomUUID(), input: parsed.data, unconfirmed: false };
    }
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    setSaved('');
    try {
      const attempt = pending.current,
        response = await api.save(attempt.input, attempt.key),
        body = await response.json();
      if (!response.ok) {
        const code = body?.error?.code;
        if (response.status >= 500 || response.status < 400) {
          unknown();
          return;
        }
        if (attempt.unconfirmed && [401, 403, 429].includes(response.status)) {
          setUncertain(true);
          setMessage(
            response.status === 429
              ? 'Too many requests. Wait, then retry with the same draft.'
              : 'Sign in or resolve account access, then retry with the same draft. Keep this page open.',
          );
          return;
        }
        if (code === 'IDEMPOTENCY_KEY_REUSED') {
          unknown();
          return;
        }
        pending.current = null;
        setUncertain(false);
        if (code === 'REVISION_CHANGED' && state.draft) {
          setNeedsRevision(true);
          setMessage(
            'Saved details changed. Reload the saved revision, then review your preserved draft.',
          );
        } else
          setMessage(
            code === 'DRAFT_SLUG_UNAVAILABLE'
              ? 'That draft URL is unavailable. Choose another; your other fields are preserved.'
              : response.status === 401
                ? 'Sign in again to save your draft.'
                : response.status === 403
                  ? 'Saving is not permitted for this account.'
                  : response.status === 429
                    ? 'Too many requests. Wait, then save your draft again.'
                    : 'Check your fields and try again.',
          );
        return;
      }
      const parsed = GuildDraftHttpSavedSchema.safeParse(body);
      if (!parsed.success) throw Error('Invalid saved response');
      const result = parsed.data.draft;
      if (
        result.revision !== attempt.input.expectedRevision + 1 ||
        (attempt.input.guildDraftId !== null &&
          result.id.toLowerCase() !== attempt.input.guildDraftId.toLowerCase()) ||
        result.profile.name !== attempt.input.profile.name ||
        result.profile.slug !== attempt.input.profile.slug ||
        result.profile.description !== attempt.input.profile.description
      )
        throw Error('Wrong command response');
      setState((s) => ({ ...s, draft: result }));
      setDraft(result.profile);
      pending.current = null;
      setUncertain(false);
      setNeedsRevision(false);
      setSaved('Draft saved.');
    } catch {
      unknown();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (inFlight.current || !state.draft) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const response = await api.read(state.draft.id),
        parsed = GuildDraftHttpStateSchema.safeParse(await response.json());
      if (
        !response.ok ||
        !parsed.success ||
        parsed.data.draft.id.toLowerCase() !== state.draft.id.toLowerCase()
      )
        throw Error('Read failed');
      setState(parsed.data);
      pending.current = null;
      setUncertain(false);
      setNeedsRevision(false);
      setSaved(
        'Saved revision reloaded. Your draft is preserved. Review the saved details before saving.',
      );
    } catch {
      setMessage('Saved details could not be loaded. Your draft is preserved.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="orientation-layout">
      <section className="orientation-card">
        <h2>Your private draft</h2>
        <p>This draft stays private.</p>
        <p>Founder control has not been verified.</p>
        {!state.writesAvailable && (
          <p role="status">
            Saving drafts is currently unavailable. Existing saved details remain readable.
          </p>
        )}
        <form onSubmit={submit} noValidate aria-busy={busy}>
          <fieldset
            className="orientation-fields"
            disabled={busy || uncertain || !state.writesAvailable}
          >
            <legend className="visually-hidden">Private Guild draft fields</legend>
            <label>
              Guild name
              <input
                aria-label="Guild name"
                required
                maxLength={200}
                value={draft.name}
                onChange={(e) => update('name', e.target.value)}
              />
            </label>
            <label>
              Draft URL
              <input
                aria-label="Draft URL"
                required
                maxLength={100}
                value={draft.slug}
                disabled={!!state.draft}
                onChange={(e) => update('slug', e.target.value)}
              />
              <span className="orientation-hint">
                Use lowercase letters, numbers and single hyphens. Saved draft URLs stay fixed.
              </span>
            </label>
            <label>
              Description
              <textarea
                aria-label="Description"
                maxLength={4000}
                rows={6}
                value={draft.description}
                onChange={(e) => update('description', e.target.value)}
              />
            </label>
          </fieldset>
          {message && (
            <p role="alert" tabIndex={-1} ref={alert}>
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
              {busy ? 'Saving…' : uncertain ? 'Retry save' : 'Save private draft'}
            </button>
            {needsRevision && (
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() => void reload()}
              >
                Reload saved revision
              </button>
            )}
          </div>
        </form>
        {state.draft && (
          <p>
            <a className="inline-link" href={draftLinkPrefix + encodeURIComponent(state.draft.id)}>
              Open saved draft
            </a>
          </p>
        )}
      </section>
      {state.draft && (
        <section className="orientation-card" aria-label="Saved details">
          <h2>Saved revision {state.draft.revision}</h2>
          <p>{state.draft.profile.name}</p>
          <p>{state.draft.profile.slug}</p>
          <p>{state.draft.profile.description}</p>
        </section>
      )}
    </div>
  );
}
