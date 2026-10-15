'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { z } from 'zod';
import { ParticipantId } from '../contracts/ids';
import { PublishedSkillTaxonomySchema, type PublishedSkillTaxonomy } from '../skills/contracts';
import {
  SkillClaimHttpInputSchema,
  SkillClaimHttpStateSchema,
  SkillClaimHttpSavedSchema,
  SkillCatalogHttpStateSchema,
  type SkillClaimHttpState,
} from '../skills/http-contracts';
type Input = z.infer<typeof SkillClaimHttpInputSchema>;
export interface SkillClaimTransport {
  save(skillId: string, input: Input, key: string): Promise<Response>;
  read(skillId: string): Promise<Response>;
  readCatalog(taxonomyId: string): Promise<Response>;
}
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
const transport: SkillClaimTransport = {
  save: (id, input, key) =>
    fetch('/api/v1/skill-claims/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(input),
    }),
  read: (id) => fetch('/api/v1/skill-claims/' + encodeURIComponent(id), { cache: 'no-store' }),
  readCatalog: (id) =>
    fetch('/api/v1/skill-taxonomies/' + encodeURIComponent(id), { cache: 'no-store' }),
};
export function SkillClaimForm({
  state: initial,
  catalog: initialCatalog,
  participantId,
  api = transport,
}: {
  state: SkillClaimHttpState;
  catalog: PublishedSkillTaxonomy;
  participantId: string;
  api?: SkillClaimTransport;
}) {
  const checked = SkillClaimHttpStateSchema.parse(initial),
    published = PublishedSkillTaxonomySchema.parse(initialCatalog);
  ParticipantId.parse(participantId);
  const initialCategory = published.skills.find((s) => s.id === checked.skillId);
  if (
    !initialCategory ||
    (checked.claim &&
      (checked.claim.participantId !== participantId ||
        checked.claim.taxonomyReference.recordId !== published.id ||
        checked.claim.skillDomain !== initialCategory.domain))
  )
    throw Error('INVALID_HOST_CONTRACT');
  const skillDomain = initialCategory.domain;
  const [state, setState] = useState(checked),
    [catalog, setCatalog] = useState(published);
  const [fields, setFields] = useState({
    level: checked.claim?.claimedLevel ?? '',
    references: checked.claim?.supportingReferences.join('\n') ?? '',
  });
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [needsRevision, setNeedsRevision] = useState(false),
    [message, setMessage] = useState(''),
    [saved, setSaved] = useState('');
  const pending = useRef<{ key: string; input: Input; unconfirmed: boolean } | null>(null),
    inFlight = useRef(false),
    alert = useRef<HTMLParagraphElement>(null);
  const category = catalog.skills.find((s) => s.id === state.skillId),
    available = state.writesAvailable && category?.status === 'ACTIVE';
  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);
  function update(field: keyof typeof fields, value: string) {
    setFields((old) => ({ ...old, [field]: value }));
    setMessage('');
    setSaved('');
  }
  function unknown() {
    if (pending.current) pending.current.unconfirmed = true;
    setUncertain(true);
    setMessage('The save could not be confirmed. Keep this page open. Retry with the same claim.');
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!pending.current) {
      const parsed = SkillClaimHttpInputSchema.safeParse({
        taxonomyId: catalog.id,
        expectedTaxonomyRevision: catalog.revision,
        expectedClaimRevision: state.claim?.revision ?? 0,
        claimedLevel: fields.level,
        supportingReferences: fields.references
          .split(/\r?\n/)
          .map((v) => v.trim())
          .filter(Boolean),
      });
      if (!parsed.success) {
        setMessage(
          'Enter your self-reported experience and up to five different HTTPS proof URLs without credentials, one per line.',
        );
        return;
      }
      pending.current = {
        key: crypto.randomUUID(),
        input: Object.freeze(parsed.data),
        unconfirmed: false,
      };
    }
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    setSaved('');
    try {
      const attempt = pending.current,
        response = await api.save(state.skillId, attempt.input, attempt.key),
        body = await response.json();
      if (!response.ok) {
        const code = body?.error?.code;
        if (response.status >= 500 || response.status < 400 || code === 'IDEMPOTENCY_KEY_REUSED') {
          unknown();
          return;
        }
        if (attempt.unconfirmed && [401, 403, 429].includes(response.status)) {
          setUncertain(true);
          setMessage(
            response.status === 429
              ? 'Too many requests. Wait, then retry with the same claim.'
              : 'Sign in or resolve account access, then retry with the same claim. Keep this page open.',
          );
          return;
        }
        pending.current = null;
        setUncertain(false);
        if (code === 'REVISION_CHANGED') {
          setNeedsRevision(true);
          setMessage(
            'Saved details changed. Reload the saved revision, then review your preserved claim.',
          );
        } else
          setMessage(
            response.status === 401
              ? 'Sign in again to save your claim.'
              : response.status === 403
                ? 'Saving is not permitted for this account.'
                : response.status === 429
                  ? 'Too many requests. Wait, then save your claim again.'
                  : 'Saving is unavailable or the fields need correction. Your draft is preserved.',
          );
        return;
      }
      const parsed = SkillClaimHttpSavedSchema.safeParse(body);
      if (!parsed.success) throw Error('Invalid private acknowledgment');
      const value = parsed.data,
        c = value.claim;
      if (
        c.skillId !== state.skillId ||
        c.participantId !== participantId ||
        c.skillDomain !== skillDomain ||
        (state.claim && c.id !== state.claim.id) ||
        c.revision !== attempt.input.expectedClaimRevision + 1 ||
        c.taxonomyReference.recordId !== attempt.input.taxonomyId ||
        c.taxonomyReference.revision !== attempt.input.expectedTaxonomyRevision ||
        c.claimedLevel !== attempt.input.claimedLevel ||
        JSON.stringify(c.supportingReferences) !==
          JSON.stringify(attempt.input.supportingReferences)
      )
        throw Error('Wrong command response');
      setState({
        version: 'v1',
        skillId: state.skillId,
        claim: c,
        writesAvailable: value.writesAvailable,
        unavailableReason: value.unavailableReason,
      });
      setFields({ level: c.claimedLevel, references: c.supportingReferences.join('\n') });
      pending.current = null;
      setUncertain(false);
      setNeedsRevision(false);
      setSaved('Claim saved.');
    } catch {
      unknown();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (inFlight.current || pending.current?.unconfirmed) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const [response, catalogResponse] = await Promise.all([
        api.read(state.skillId),
        api.readCatalog(catalog.id),
      ]);
      const next = SkillClaimHttpStateSchema.safeParse(await response.json()),
        nextCatalog = SkillCatalogHttpStateSchema.safeParse(await catalogResponse.json());
      if (
        !response.ok ||
        !catalogResponse.ok ||
        !next.success ||
        !nextCatalog.success ||
        next.data.skillId !== state.skillId ||
        nextCatalog.data.taxonomyId !== catalog.id ||
        !nextCatalog.data.taxonomy
      )
        throw Error('Read failed');
      const tax = nextCatalog.data.taxonomy,
        skill = tax.skills.find((s) => s.id === state.skillId),
        claim = next.data.claim;
      if (
        !skill ||
        skill.domain !== skillDomain ||
        (claim &&
          (claim.participantId !== participantId ||
            claim.taxonomyReference.recordId !== catalog.id ||
            (state.claim && claim.id !== state.claim.id)))
      )
        throw Error('Wrong saved resource');
      setState(next.data);
      setCatalog(tax);
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
        <h2>Your private claim</h2>
        <p>Self-reported claim; this claim does not verify a rank.</p>
        <p>Saving does not verify a rank or grant work, code access or another active Raid.</p>
        {!available && (
          <p role="status">
            Saving new claims is currently unavailable. Existing saved details remain readable.
          </p>
        )}
        {!ready && <p role="status">Loading private claim controls…</p>}
        <noscript>
          <p>Turn on JavaScript to edit this claim. Saved details remain readable.</p>
        </noscript>
        <form onSubmit={submit} noValidate aria-busy={busy || !ready}>
          <fieldset
            className="orientation-fields"
            disabled={!ready || busy || uncertain || !available}
          >
            <legend className="visually-hidden">Private skill claim fields</legend>
            <label>
              Self-reported experience
              <input
                aria-label="Self-reported experience"
                maxLength={200}
                value={fields.level}
                onChange={(e) => update('level', e.target.value)}
              />
              <span className="orientation-hint">
                Describe what you can do. This text is a claim, not an assessed rank.
              </span>
            </label>
            <label>
              Private proof URLs
              <textarea
                aria-label="Private proof URLs"
                rows={5}
                maxLength={10244}
                value={fields.references}
                onChange={(e) => update('references', e.target.value)}
              />
              <span className="orientation-hint">
                Up to five different HTTPS URLs, one per line. Links stay private and are not
                fetched or verified.
              </span>
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
              disabled={!ready || busy || needsRevision || (!available && !uncertain)}
            >
              {busy ? 'Saving…' : uncertain ? 'Retry save' : 'Save private claim'}
            </button>
            {needsRevision && (
              <button className="button secondary" type="button" disabled={busy} onClick={reload}>
                Reload saved revision
              </button>
            )}
          </div>
        </form>
      </section>
      <section className="orientation-card">
        <h2>Saved claim</h2>
        {state.claim ? (
          <>
            <p>Claim revision {state.claim.revision}</p>
            <p>{state.claim.claimedLevel}</p>
            <p>Saved private proof URLs</p>
            <ul>
              {state.claim.supportingReferences.map((r) => (
                <li key={r} style={{ overflowWrap: 'anywhere' }}>
                  {r}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No claim has been saved for this skill.</p>
        )}
        <p>Assessment and relevant trials require a separate authorized review.</p>
      </section>
    </div>
  );
}
