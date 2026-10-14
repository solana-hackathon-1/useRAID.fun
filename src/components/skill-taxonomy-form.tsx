'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { prepareSkillTaxonomyUpdate } from '../skills';
import {
  SkillTaxonomyEditorStateSchema,
  SkillTaxonomyHttpPublishedSchema,
  SkillTaxonomyHttpInputSchema,
  type SkillTaxonomyEditorState,
  type SkillTaxonomyEditorInput,
  type SkillTaxonomyHttpInput,
} from '../skills/taxonomy-http-contracts';
export type {
  SkillTaxonomyEditorState,
  SkillTaxonomyEditorInput,
} from '../skills/taxonomy-http-contracts';
export interface SkillTaxonomyTransport {
  publish(id: string, input: SkillTaxonomyHttpInput, key: string): Promise<Response>;
  read(id: string): Promise<Response>;
}
const transport: SkillTaxonomyTransport = {
  publish: (id, input, key) =>
    fetch('/api/v1/admin/skill-taxonomies/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(input),
    }),
  read: (id) =>
    fetch('/api/v1/admin/skill-taxonomies/' + encodeURIComponent(id), { cache: 'no-store' }),
};
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
type Row = {
  key: string;
  originalId: string | null;
  id: string;
  domain: string;
  name: string;
  status: 'ACTIVE' | 'RETIRED';
  aliases: string;
};
function storedRows(state: SkillTaxonomyEditorState): Row[] {
  return (
    state.taxonomy?.skills.map((s) => ({
      key: s.id,
      originalId: s.id,
      id: s.id,
      domain: s.domain,
      name: s.name,
      status: s.status,
      aliases: '',
    })) ?? []
  );
}
export function SkillTaxonomyForm({
  state: initial,
  api = transport,
}: {
  state: SkillTaxonomyEditorInput;
  api?: SkillTaxonomyTransport;
}) {
  const parsed = SkillTaxonomyEditorStateSchema.safeParse(initial);
  if (!parsed.success) throw Error('INVALID_HOST_CONTRACT');
  const [state, setState] = useState(parsed.data),
    [rows, setRows] = useState(() => storedRows(parsed.data));
  const [review, setReview] = useState<SkillTaxonomyHttpInput | null>(null);
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [needsRevision, setNeedsRevision] = useState(false);
  const [message, setMessage] = useState(''),
    [saved, setSaved] = useState('');
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const pending = useRef<{
      key: string;
      input: SkillTaxonomyHttpInput;
      unconfirmed: boolean;
    } | null>(null),
    inFlight = useRef(false),
    alert = useRef<HTMLParagraphElement>(null);
  const editable = ready && !busy && !uncertain && state.writesAvailable;
  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);
  function changed() {
    setReview(null);
    setMessage('');
    setSaved('');
  }
  function update(key: string, field: 'id' | 'domain' | 'name' | 'aliases', value: string) {
    setRows((old) => old.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
    changed();
  }
  function add() {
    if (!editable || rows.length >= 1000) return;
    setRows((old) => [
      ...old,
      {
        key: crypto.randomUUID(),
        originalId: null,
        id: '',
        domain: '',
        name: '',
        status: 'ACTIVE',
        aliases: '',
      },
    ]);
    changed();
  }
  function discard(row: Row) {
    const stored = state.taxonomy?.skills.find((s) => s.id === row.id);
    setRows((old) =>
      stored
        ? old.map((r) =>
            r.key === row.key
              ? {
                  key: r.key,
                  originalId: stored.id,
                  id: stored.id,
                  domain: stored.domain,
                  name: stored.name,
                  status: stored.status,
                  aliases: '',
                }
              : r,
          )
        : old.filter((r) => r.key !== row.key),
    );
    changed();
  }
  function reviewDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || needsRevision || inFlight.current) return;
    try {
      const proposal = prepareSkillTaxonomyUpdate(state.taxonomy, {
        taxonomyId: state.taxonomyId,
        expectedRevision: state.taxonomy?.revision ?? 0,
        skills: rows.map((r) => ({
          id: r.id,
          domain: r.domain,
          name: r.name,
          status: r.status,
          aliases: [
            ...(state.taxonomy?.skills.find((s) => s.id === r.id)?.aliases ?? []),
            ...r.aliases.split(/[\s,]+/).filter(Boolean),
          ],
        })),
      });
      const input = Object.freeze(
        SkillTaxonomyHttpInputSchema.parse({
          expectedRevision: state.taxonomy?.revision ?? 0,
          skills: proposal.taxonomy.skills,
        }),
      );
      if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 16384)
        throw Error('TOO_LARGE');
      if (
        state.taxonomy &&
        JSON.stringify(input.skills) === JSON.stringify(state.taxonomy.skills)
      ) {
        setMessage('There are no changes to publish.');
        return;
      }
      setReview(input);
      setMessage('');
      setSaved('');
    } catch {
      setReview(null);
      setMessage(
        'Enter valid unique skill IDs, domains, names and aliases. Preserve published IDs, domains and aliases; keep the catalog within the publication size limit. Your draft is preserved.',
      );
    }
  }
  function unknown() {
    if (pending.current) pending.current.unconfirmed = true;
    setUncertain(true);
    setMessage(
      'The publication could not be confirmed. Keep this page open and retry this same publication.',
    );
  }
  async function publish() {
    if (
      !ready ||
      inFlight.current ||
      (!pending.current && (!review || !state.writesAvailable || needsRevision))
    )
      return;
    if (!pending.current)
      pending.current = { key: crypto.randomUUID(), input: review!, unconfirmed: false };
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    setSaved('');
    try {
      const attempt = pending.current,
        response = await api.publish(state.taxonomyId, attempt.input, attempt.key),
        body = await response.json();
      if (!response.ok) {
        const code = body?.error?.code;
        if (response.status >= 500 || response.status < 400 || code === 'IDEMPOTENCY_KEY_REUSED') {
          unknown();
          return;
        }
        if (attempt.unconfirmed) {
          setUncertain(true);
          setMessage(
            response.status === 429
              ? 'Too many requests. Wait, then retry the same publication.'
              : response.status === 401 || response.status === 403
                ? 'Restore your X administrator access, then retry this same publication. Keep this page open.'
                : 'The original publication remains unconfirmed. Retry this same publication.',
          );
          return;
        }
        pending.current = null;
        setReview(null);
        setUncertain(false);
        if (code === 'REVISION_CHANGED') {
          setNeedsRevision(true);
          setMessage(
            'The catalog changed. Reload the saved revision, then review your preserved draft.',
          );
        } else
          setMessage(
            'Publication is unavailable or not permitted. Your draft is preserved; review it before trying again.',
          );
        return;
      }
      const checked = SkillTaxonomyHttpPublishedSchema.safeParse(body);
      if (
        !checked.success ||
        checked.data.taxonomy.id !== state.taxonomyId ||
        checked.data.taxonomy.publishedByAccountId !== state.publisherAccountId ||
        checked.data.taxonomy.revision !== attempt.input.expectedRevision + 1 ||
        JSON.stringify(checked.data.taxonomy.skills) !== JSON.stringify(attempt.input.skills)
      )
        throw Error('INVALID_ACKNOWLEDGMENT');
      const next = {
        ...state,
        taxonomy: checked.data.taxonomy,
        writesAvailable: checked.data.writesAvailable,
        unavailableReason: checked.data.unavailableReason,
      };
      setState(next);
      setRows(storedRows(next));
      pending.current = null;
      setReview(null);
      setUncertain(false);
      setNeedsRevision(false);
      setSaved('Catalog published.');
    } catch {
      unknown();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (!ready || inFlight.current || pending.current?.unconfirmed) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const response = await api.read(state.taxonomyId),
        next = SkillTaxonomyEditorStateSchema.safeParse(await response.json());
      if (
        !response.ok ||
        !next.success ||
        next.data.taxonomyId !== state.taxonomyId ||
        next.data.publisherAccountId !== state.publisherAccountId
      )
        throw Error('INVALID_READ');
      const tax = next.data.taxonomy;
      if (state.taxonomy) {
        if (
          !tax ||
          tax.revision < state.taxonomy.revision ||
          (tax.revision === state.taxonomy.revision &&
            JSON.stringify(tax) !== JSON.stringify(state.taxonomy))
        )
          throw Error('INVALID_HISTORY');
        prepareSkillTaxonomyUpdate(state.taxonomy, {
          taxonomyId: state.taxonomyId,
          expectedRevision: state.taxonomy.revision,
          skills: tax.skills,
        });
      }
      setState(next.data);
      setRows((draft) => [
        ...draft,
        ...storedRows(next.data).filter((r) => !draft.some((d) => d.id === r.id)),
      ]);
      pending.current = null;
      setReview(null);
      setUncertain(false);
      setNeedsRevision(false);
      setSaved(
        'Saved revision reloaded. Your draft is preserved; review the current saved details before publishing.',
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
        <h2>Edit categories</h2>
        <p>
          Published skill IDs, domains and existing aliases stay stable. Retiring a category
          preserves its history.
        </p>
        <p>Catalog changes do not assess a skill, verify a rank or grant work or code access.</p>
        {!state.writesAvailable && <p role="status">Publication is currently unavailable.</p>}
        {!ready && <p role="status">Loading catalog controls…</p>}
        <noscript>
          <p>Turn on JavaScript to edit categories. Saved catalog details remain readable.</p>
        </noscript>
        <form onSubmit={reviewDraft} noValidate aria-busy={busy || !ready}>
          <fieldset className="orientation-fields" disabled={!editable}>
            <legend className="visually-hidden">Catalog draft fields</legend>
            {rows.map((row, index) => {
              const existing = state.taxonomy?.skills.find((s) => s.id === row.id);
              return (
                <fieldset
                  key={row.key}
                  className="orientation-card"
                  style={{ margin: 0, minWidth: 0 }}
                >
                  <legend>Category {index + 1}</legend>
                  <label>
                    Skill ID
                    <input
                      aria-label="Skill ID"
                      value={row.id}
                      readOnly={row.originalId !== null}
                      maxLength={200}
                      onChange={(e) => update(row.key, 'id', e.target.value)}
                    />
                  </label>
                  <label>
                    Skill domain
                    <input
                      aria-label="Skill domain"
                      value={row.domain}
                      readOnly={row.originalId !== null}
                      maxLength={200}
                      onChange={(e) => update(row.key, 'domain', e.target.value)}
                    />
                  </label>
                  <label>
                    Category name
                    <input
                      aria-label="Category name"
                      value={row.name}
                      maxLength={200}
                      onChange={(e) => update(row.key, 'name', e.target.value)}
                    />
                  </label>
                  <label>
                    Category status
                    <select
                      aria-label="Category status"
                      value={row.status}
                      onChange={(e) => {
                        setRows((old) =>
                          old.map((r) =>
                            r.key === row.key
                              ? {
                                  ...r,
                                  status: e.target.value === 'RETIRED' ? 'RETIRED' : 'ACTIVE',
                                }
                              : r,
                          ),
                        );
                        changed();
                      }}
                    >
                      <option value="ACTIVE">Active</option>
                      <option value="RETIRED">Retired</option>
                    </select>
                  </label>
                  {existing && (
                    <>
                      <p>Existing aliases are retained:</p>
                      <ul>
                        {existing.aliases.map((a) => (
                          <li key={a} style={{ overflowWrap: 'anywhere' }}>
                            {a}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <label>
                    {existing ? 'Additional aliases' : 'Aliases'}
                    <input
                      aria-label={existing ? 'Additional aliases' : 'Aliases'}
                      value={row.aliases}
                      maxLength={10100}
                      onChange={(e) => update(row.key, 'aliases', e.target.value)}
                    />
                    <span className="orientation-hint">
                      Separate aliases with commas or spaces.
                    </span>
                  </label>
                  {row.originalId === null && (
                    <button type="button" className="button secondary" onClick={() => discard(row)}>
                      Discard new category
                    </button>
                  )}
                </fieldset>
              );
            })}
            <button
              type="button"
              className="button secondary"
              onClick={add}
              disabled={rows.length >= 1000}
            >
              Add category
            </button>
          </fieldset>
          {message && (
            <p role="alert" tabIndex={-1} ref={alert}>
              {message}
            </p>
          )}
          {saved && <p role="status">{saved}</p>}
          <div className="orientation-actions">
            <button
              type="submit"
              className="button secondary"
              disabled={!editable || needsRevision}
            >
              Review changes
            </button>
            {(review || uncertain) && (
              <button
                type="button"
                className="button"
                disabled={
                  !ready || busy || (!uncertain && (!state.writesAvailable || needsRevision))
                }
                onClick={publish}
              >
                {busy
                  ? 'Publishing…'
                  : uncertain
                    ? 'Retry publication'
                    : 'Publish reviewed catalog'}
              </button>
            )}
            {needsRevision && (
              <button
                type="button"
                className="button secondary"
                disabled={!ready || busy || uncertain}
                onClick={reload}
              >
                Reload saved revision
              </button>
            )}
          </div>
          {review && (
            <section aria-label="Review publication">
              <h3>Review publication</h3>
              <p>
                Proposed revision {review.expectedRevision + 1}. Review each category before
                publishing.
              </p>
              <ul>
                {review.skills.map((s) => {
                  const old = state.taxonomy?.skills.find((v) => v.id === s.id);
                  return (
                    <li key={s.id} style={{ overflowWrap: 'anywhere' }}>
                      <strong>{s.name}</strong>
                      <p>
                        {old ? `Saved: ${old.name} (${old.status}).` : 'New category.'} Proposed:{' '}
                        {s.name} ({s.status}).
                      </p>
                      <p>
                        ID: {s.id}. Domain: {s.domain}. Aliases: {s.aliases.join(', ')}.
                      </p>
                    </li>
                  );
                })}
              </ul>
              <p>
                This preview does not publish or grant permission. Current administrator authority
                and catalog history are checked again by the server.
              </p>
            </section>
          )}
        </form>
      </section>
      <section className="orientation-card" aria-label="Saved catalog">
        <h2>Saved catalog</h2>
        {state.taxonomy ? (
          <>
            <p>Catalog revision {state.taxonomy.revision}</p>
            <ul>
              {state.taxonomy.skills.map((s) => (
                <li key={s.id} style={{ overflowWrap: 'anywhere' }}>
                  <strong>{s.name}</strong>
                  <p>
                    {s.status} · {s.id} · {s.domain}
                  </p>
                  <p>Aliases: {s.aliases.join(', ')}</p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No catalog has been published.</p>
        )}
      </section>
    </div>
  );
}
