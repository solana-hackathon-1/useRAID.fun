'use client';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { PracticeTrialDefinition } from '../skills/practice-trial-contracts';
import {
  PracticePortalCatalogSchema,
  PracticePortalProgressSchema,
  PracticePortalStartResultSchema,
  PracticePortalSubmitResultSchema,
  buildSubmitInput,
  createPracticePortalTransport,
  describePracticeFailure,
  type PracticePortalCatalog,
  type PracticePortalProgress,
  type PracticePortalSubmitInput,
  type PracticePortalTransport,
} from '../skills/practice-portal-client';

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
const wrap = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
const defaultTransport = createPracticePortalTransport();
const defaultNavigate = (href: string) => window.location.assign(href);
const defaultWorkspaceHref = (startId: string) => '/raider/practice/' + encodeURIComponent(startId);

function when(value: string) {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value)) + ' UTC'
  );
}
function plural(n: number, one: string, many: string) {
  return n + ' ' + (n === 1 ? one : many);
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
async function failure(response: Response) {
  let code: unknown;
  try {
    code = ((await response.json()) as { error?: { code?: unknown } })?.error?.code;
  } catch {
    /* A non-JSON failure is described generically. */
  }
  return { status: response.status, text: describePracticeFailure(response.status, code), code };
}

/** The saved, immutable terms exactly as published; never edited or reinterpreted client-side. */
function TrialTerms({ definition: d }: { definition: PracticeTrialDefinition }) {
  const evaluator =
    d.evaluatorMethod === 'MANUAL' ? 'Manual review' : 'Automated checks with manual review';
  return (
    <div>
      <p style={wrap}>{d.brief}</p>
      <p>
        Practice level: {d.targetRank}. Expected time: about{' '}
        {plural(d.expectedMinutes, 'minute', 'minutes')} (an expectation, not a deadline).
      </p>
      <p>
        Up to {plural(d.maximumAttempts, 'attempt', 'attempts')}
        {d.cooldownSeconds > 0
          ? ', with ' + plural(d.cooldownSeconds, 'second', 'seconds') + ' between attempts'
          : ''}
        .
      </p>
      <h4>
        Materials (
        {d.inputs.some((i) => i.material === 'PUBLIC') ? 'public or synthetic' : 'synthetic'})
      </h4>
      <ul>
        {d.inputs.map((input, index) => (
          <li key={index}>
            <strong>{input.label}</strong> ({input.material === 'PUBLIC' ? 'Public' : 'Synthetic'})
            <pre style={wrap}>{input.content}</pre>
          </li>
        ))}
      </ul>
      <h4>Tools and AI assistance</h4>
      <p>
        {d.tools.permitted.length
          ? 'Permitted tools: ' + d.tools.permitted.join(', ') + '.'
          : 'No specific tools are listed.'}{' '}
        AI assistance is {d.tools.aiAssistance === 'ALLOWED' ? 'allowed' : 'prohibited'}.
      </p>
      <p style={wrap}>{d.tools.disclosure}</p>
      <h4>Review criteria</h4>
      <ul>
        {d.rubric.criteria.map((c) => (
          <li key={c.id}>
            {c.required ? 'Required' : 'Optional'}: <span style={wrap}>{c.description}</span>
          </li>
        ))}
      </ul>
      <p>Evaluation: {evaluator}.</p>
      <p style={wrap}>{d.passConditions}</p>
      <h4>Accommodations</h4>
      <p style={wrap}>{d.accommodationPolicy}</p>
      <p>Accommodations are not available through this page.</p>
    </div>
  );
}

const inertNotice = 'Practice does not verify a skill, rank, access, capacity or payment.';

export interface PracticeTrialCatalogProps {
  /** Server-read catalog for the configured taxonomy, or null when reads are unavailable. */
  initial: PracticePortalCatalog | null;
  readsAvailable: boolean;
  writesAvailable: boolean;
  api?: PracticePortalTransport;
  workspaceHref?: (startId: string) => string;
  navigate?: (href: string) => void;
}
export function PracticeTrialCatalog(props: PracticeTrialCatalogProps) {
  let checked: PracticePortalCatalog | null = null;
  if (props.readsAvailable && props.initial) {
    const parsed = PracticePortalCatalogSchema.safeParse(props.initial);
    if (
      !parsed.success ||
      parsed.data.trials.some(
        (t) =>
          t.availability !== 'AVAILABLE' || t.taxonomyReference.recordId !== parsed.data.taxonomyId,
      )
    )
      throw Error('INVALID_HOST_CONTRACT');
    checked = parsed.data;
  }
  return <CatalogState {...props} checked={checked} />;
}
function CatalogState({
  checked,
  writesAvailable,
  api = defaultTransport,
  workspaceHref = defaultWorkspaceHref,
  navigate = defaultNavigate,
}: PracticeTrialCatalogProps & { checked: PracticePortalCatalog | null }) {
  const title = useId(),
    ready = useSyncExternalStore(subscribeReady, clientReady, serverReady),
    [trials, setTrials] = useState(checked?.trials ?? []),
    [cursor, setCursor] = useState(checked?.nextCursor ?? null),
    [busy, setBusy] = useState<string | null>(null),
    [uncertain, setUncertain] = useState<string | null>(null),
    [message, setMessage] = useState(''),
    pending = useRef(new Map<string, { key: string; unconfirmed: boolean }>()),
    inFlight = useRef(false),
    alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);
  if (!checked)
    return (
      <section className="orientation-card" aria-labelledby={title}>
        <h2 id={title}>Practice trials</h2>
        <p role="status">Practice trials are currently unavailable. Try again later.</p>
      </section>
    );
  const taxonomyId = checked.taxonomyId;
  async function start(index: number) {
    const trial = trials[index];
    if (!trial || inFlight.current) return;
    const reference = trial.definition.reference,
      id = reference.recordId + '@' + reference.revision;
    let attempt = pending.current.get(id);
    if (!attempt) {
      attempt = { key: crypto.randomUUID(), unconfirmed: false };
      pending.current.set(id, attempt);
    }
    inFlight.current = true;
    setBusy(id);
    setMessage('');
    try {
      const response = await api.start(reference, attempt.key);
      if (!response.ok) {
        const f = await failure(response);
        if (response.status >= 500 || f.code === 'IDEMPOTENCY_KEY_REUSED') {
          attempt.unconfirmed = true;
          setUncertain(id);
          setMessage('The start could not be confirmed. Retry to continue the same attempt.');
          return;
        }
        pending.current.delete(id);
        setUncertain(null);
        setMessage(f.text);
        return;
      }
      const parsed = PracticePortalStartResultSchema.safeParse(await response.json());
      if (
        !parsed.success ||
        !same(parsed.data.start.definition.reference, reference) ||
        !same(parsed.data.start.definition, trial.definition)
      )
        throw Error('Wrong command response');
      navigate(workspaceHref(parsed.data.start.id));
    } catch {
      attempt.unconfirmed = true;
      setUncertain(id);
      setMessage('The start could not be confirmed. Retry to continue the same attempt.');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  async function more() {
    if (cursor === null || inFlight.current) return;
    inFlight.current = true;
    setBusy('more');
    setMessage('');
    try {
      const response = await api.list(cursor);
      if (!response.ok) {
        setMessage((await failure(response)).text);
        return;
      }
      const parsed = PracticePortalCatalogSchema.safeParse(await response.json());
      if (
        !parsed.success ||
        parsed.data.taxonomyId !== taxonomyId ||
        parsed.data.trials.some(
          (t) => t.availability !== 'AVAILABLE' || t.taxonomyReference.recordId !== taxonomyId,
        )
      )
        throw Error('Wrong catalog');
      const known = new Set(trials.map((t) => t.definition.reference.recordId));
      setTrials([
        ...trials,
        ...parsed.data.trials.filter((t) => !known.has(t.definition.reference.recordId)),
      ]);
      setCursor(parsed.data.nextCursor);
    } catch {
      setMessage('More practice trials could not be loaded. Try again.');
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  return (
    <section
      className="orientation-card"
      aria-labelledby={title}
      aria-busy={busy !== null || !ready}
    >
      <h2 id={title}>Practice trials</h2>
      <p>{inertNotice} Practice is unpaid and uses public or synthetic material only.</p>
      {!writesAvailable && (
        <p role="status">
          Starting practice is currently unavailable. Published terms remain readable.
        </p>
      )}
      {!ready && <p role="status">Loading practice controls…</p>}
      {trials.length ? (
        <ul className="orientation-fields" style={{ listStyle: 'none', padding: 0 }}>
          {trials.map((trial, index) => {
            const d = trial.definition,
              id = d.reference.recordId + '@' + d.reference.revision;
            return (
              <li key={id}>
                <article aria-label={d.title}>
                  <h3>{d.title}</h3>
                  <TrialTerms definition={d} />
                  <div className="orientation-actions">
                    <button
                      className="button"
                      type="button"
                      disabled={!ready || busy !== null || (!writesAvailable && uncertain !== id)}
                      onClick={() => start(index)}
                    >
                      {busy === id
                        ? 'Starting…'
                        : uncertain === id
                          ? 'Retry start'
                          : 'Start practice'}
                    </button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>No practice trials are available.</p>
      )}
      {message && (
        <p role="alert" tabIndex={-1} ref={alert}>
          {message}
        </p>
      )}
      {cursor !== null && (
        <button
          className="button secondary"
          type="button"
          disabled={!ready || busy !== null}
          onClick={more}
        >
          {busy === 'more' ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}

export interface PracticeTrialWorkspaceProps {
  initial: PracticePortalProgress;
  writesAvailable: boolean;
  api?: PracticePortalTransport;
}
export function PracticeTrialWorkspace(props: PracticeTrialWorkspaceProps) {
  const parsed = PracticePortalProgressSchema.safeParse(props.initial);
  if (!parsed.success) throw Error('INVALID_HOST_CONTRACT');
  return <WorkspaceState {...props} checked={parsed.data} />;
}
function WorkspaceState({
  checked,
  writesAvailable,
  api = defaultTransport,
}: PracticeTrialWorkspaceProps & { checked: PracticePortalProgress }) {
  const title = useId(),
    ready = useSyncExternalStore(subscribeReady, clientReady, serverReady),
    [progress, setProgress] = useState(checked),
    [fields, setFields] = useState({
      answer: '',
      explanation: '',
      tools: '',
      ai: false,
      disclosure: '',
    }),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [message, setMessage] = useState(''),
    pending = useRef<{
      key: string;
      input: PracticePortalSubmitInput;
      unconfirmed: boolean;
    } | null>(null),
    inFlight = useRef(false),
    alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);
  const { start, submission } = progress,
    d = start.definition,
    prohibited = d.tools.aiAssistance === 'PROHIBITED';
  function update<K extends keyof typeof fields>(field: K, value: (typeof fields)[K]) {
    setFields((old) => ({ ...old, [field]: value }));
    setMessage('');
    pending.current = null;
  }
  function unknown() {
    if (pending.current) pending.current.unconfirmed = true;
    setUncertain(true);
    setMessage(
      'The submission could not be confirmed. Keep this page open and check the saved status.',
    );
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!pending.current) {
      const built = buildSubmitInput({
        startId: start.id,
        definition: d,
        answer: fields.answer,
        explanation: fields.explanation,
        toolsText: fields.tools,
        aiAssistanceUsed: fields.ai,
        assistanceDisclosure: fields.disclosure,
      });
      if (!built.ok) {
        setMessage(built.message);
        return;
      }
      pending.current = { key: crypto.randomUUID(), input: built.value, unconfirmed: false };
    }
    const attempt = pending.current;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const response = await api.submit(start.id, attempt.input, attempt.key);
      if (!response.ok) {
        const f = await failure(response);
        if (response.status >= 500 || f.code === 'IDEMPOTENCY_KEY_REUSED') {
          unknown();
          return;
        }
        pending.current = null;
        setUncertain(false);
        setMessage(f.text + ' Your draft is preserved.');
        return;
      }
      const result = PracticePortalSubmitResultSchema.safeParse(await response.json()),
        s = result.success ? result.data.submission : null,
        i = attempt.input;
      if (
        !s ||
        s.startId !== start.id ||
        !same(s.definitionReference, i.expectedDefinitionReference) ||
        !same(s.rubricReference, i.expectedRubricReference) ||
        s.answer !== i.answer ||
        s.explanation !== i.explanation ||
        !same(s.toolsUsed, i.toolsUsed) ||
        s.aiAssistanceUsed !== i.aiAssistanceUsed ||
        s.assistanceDisclosure !== i.assistanceDisclosure
      )
        throw Error('Wrong command response');
      const next = PracticePortalProgressSchema.safeParse({
        version: 'v1',
        progress: 'SUBMITTED',
        start,
        submission: s,
      });
      if (!next.success) throw Error('Incoherent response');
      setProgress(next.data);
      pending.current = null;
      setUncertain(false);
    } catch {
      unknown();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const response = await api.read(start.id);
      if (!response.ok) {
        setMessage((await failure(response)).text);
        return;
      }
      const next = PracticePortalProgressSchema.safeParse(await response.json());
      if (!next.success || next.data.start.id !== start.id || !same(next.data.start, start))
        throw Error('Wrong saved resource');
      setProgress(next.data);
      if (next.data.progress === 'SUBMITTED') {
        pending.current = null;
        setUncertain(false);
      } else setMessage('No submission is saved yet. Retry to submit with the same answer.');
    } catch {
      setMessage('Saved status could not be loaded. Your draft is preserved.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="orientation-layout">
      <section className="orientation-card" aria-labelledby={title}>
        <h2 id={title}>{d.title}</h2>
        <p>
          Attempt {start.attemptNumber}, started{' '}
          <time dateTime={start.startedAt}>{when(start.startedAt)}</time>.
        </p>
        <p>{inertNotice}</p>
        <TrialTerms definition={d} />
      </section>
      <section className="orientation-card" aria-busy={busy || !ready}>
        {submission ? (
          <>
            <h2>Your submission</h2>
            <p role="status">
              Submitted{' '}
              <time dateTime={submission.submittedAt}>{when(submission.submittedAt)}</time>.
            </p>
            <p>
              Your work has not been reviewed yet. Submitted work ownership is unconfirmed until an
              authorized reviewer records a result.
            </p>
            <h3>Answer</h3>
            <pre style={wrap}>{submission.answer}</pre>
            <h3>Explanation</h3>
            <p style={wrap}>{submission.explanation}</p>
            <p>
              Tools used:{' '}
              {submission.toolsUsed.length ? submission.toolsUsed.join(', ') : 'none listed'}.
            </p>
            <p>AI assistance: {submission.aiAssistanceUsed ? 'used' : 'not used'}.</p>
            <p style={wrap}>{submission.assistanceDisclosure}</p>
          </>
        ) : (
          <>
            <h2>Submit your work</h2>
            <p>Your answer is private to you and authorized reviewers.</p>
            {!writesAvailable && (
              <p role="status">Submitting is currently unavailable. Your attempt remains saved.</p>
            )}
            {!ready && <p role="status">Loading practice controls…</p>}
            <noscript>
              <p>Turn on JavaScript to submit. Published terms remain readable.</p>
            </noscript>
            <form onSubmit={submit} noValidate>
              <fieldset
                className="orientation-fields"
                disabled={!ready || busy || uncertain || !writesAvailable}
              >
                <legend className="visually-hidden">Practice submission</legend>
                <label>
                  Answer
                  <textarea
                    rows={12}
                    maxLength={40000}
                    value={fields.answer}
                    onChange={(e) => update('answer', e.target.value)}
                  />
                </label>
                <label>
                  Explanation
                  <textarea
                    rows={5}
                    maxLength={4000}
                    value={fields.explanation}
                    onChange={(e) => update('explanation', e.target.value)}
                  />
                  <span className="orientation-hint">
                    Explain your approach so a reviewer can confirm the work is yours.
                  </span>
                </label>
                <label>
                  Tools used
                  <textarea
                    rows={3}
                    value={fields.tools}
                    onChange={(e) => update('tools', e.target.value)}
                  />
                  <span className="orientation-hint">One tool per line, up to 50.</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={fields.ai && !prohibited}
                    disabled={prohibited}
                    onChange={(e) => update('ai', e.target.checked)}
                  />{' '}
                  I used AI assistance
                  {prohibited && (
                    <span className="orientation-hint">
                      {' '}
                      AI assistance is prohibited for this trial.
                    </span>
                  )}
                </label>
                <label>
                  Assistance disclosure
                  <textarea
                    rows={3}
                    maxLength={4000}
                    value={fields.disclosure}
                    onChange={(e) => update('disclosure', e.target.value)}
                  />
                  <span className="orientation-hint">
                    Describe any help you received, or write that you used none.
                  </span>
                </label>
              </fieldset>
              {message && (
                <p role="alert" tabIndex={-1} ref={alert}>
                  {message}
                </p>
              )}
              <div className="orientation-actions">
                <button
                  className="button"
                  type="submit"
                  disabled={!ready || busy || (!writesAvailable && !uncertain)}
                >
                  {busy ? 'Submitting…' : uncertain ? 'Retry submission' : 'Submit answer'}
                </button>
                {uncertain && (
                  <button
                    className="button secondary"
                    type="button"
                    disabled={busy}
                    onClick={check}
                  >
                    Check saved status
                  </button>
                )}
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
