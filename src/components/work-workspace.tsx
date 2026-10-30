'use client';
import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { DecideReviewInput, SubmitWorkInput } from '../work-loop/submission-contracts';
import {
  createWorkClient,
  describeWorkFailure,
  newRequestKey,
  type ApplicantQueueView,
  type FailureKind,
  type MyRaidsView,
  type ReviewQueueView,
} from '../work-http/workspace-client';

type Client = ReturnType<typeof createWorkClient>;
const defaultClient = createWorkClient();
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
const wrap = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;

function when(value: string) {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value)) + ' UTC'
  );
}
/** Base units rendered with the policy's verified decimals; integer math only. */
function units(amount: string, decimals: number) {
  const value = BigInt(amount),
    scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (value / scale).toString() + (fraction ? '.' + fraction : '');
}
const STATE_TEXT: Record<string, string> = {
  ACCESS_PENDING: 'Waiting to start',
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  REVISION_REQUESTED: 'Revision requested',
  ACCEPTED: 'Accepted',
  WITHDRAWN: 'Withdrawn',
  CANCELLED: 'Cancelled',
  TERMINATED: 'Closed without acceptance',
};
const NEXT_TEXT: Record<string, string> = {
  WAIT_FOR_START: 'Setup is not finished yet. Nothing is due from you.',
  SUBMIT_WORK: 'Submit your work before the submission deadline.',
  AWAIT_REVIEW: 'Your submission is waiting for the reviewer.',
  REVISE_AND_RESUBMIT: 'Address the unmet criteria and resubmit before the revision deadline.',
  DISPUTE_OPEN:
    'The reviewer raised a dispute. Your capacity stays held until it is resolved or closed.',
  CLOSED: 'This work is closed.',
};
const REASON_TEXT: Record<string, string> = {
  ACCEPTED: 'Accepted by the reviewer.',
  ACCESS_TIMEOUT: 'Closed: setup was not finished by the operational deadline.',
  SUBMISSION_TIMEOUT: 'Closed: no submission by the operational deadline.',
  REVIEW_TIMEOUT: 'Closed: no review decision by the operational deadline.',
  REVISION_TIMEOUT: 'Closed: no resubmission by the operational deadline.',
};

interface Notice {
  intent: string;
  kind: FailureKind;
  text: string;
}
/** One idempotency key per unchanged intent, kept across unconfirmed failures so a retry cannot duplicate. */
function useRunner(reload: () => Promise<void>) {
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function run<T>(
    intent: string,
    fingerprint: unknown,
    exec: (key: string) => Promise<T>,
    success: string,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = intent + ':' + JSON.stringify(fingerprint);
    let key = keys.current.get(id);
    if (!key) keys.current.set(id, (key = newRequestKey()));
    setBusy(intent);
    setNotice(null);
    setDone(null);
    try {
      await exec(key);
      keys.current.delete(id);
      setDone(success.split('|')[1]);
      try {
        await reload();
      } catch {
        setNotice({
          intent,
          kind: 'REFRESH',
          text: 'Saved, but the latest view could not be loaded. Refresh to see it.',
        });
      }
    } catch (error) {
      const described = describeWorkFailure(error);
      if (described.kind !== 'RETRY_SAME_REQUEST') keys.current.delete(id);
      setNotice({ intent, kind: described.kind, text: described.message });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  return { run, busy, notice, done, clear: () => setNotice(null) };
}
function Feedback({
  runner,
  intent,
  reload,
}: {
  runner: ReturnType<typeof useRunner>;
  intent: string;
  reload: () => void;
}) {
  const n = runner.notice && runner.notice.intent === intent ? runner.notice : null;
  return (
    <>
      {n && (
        <p role="alert">
          {n.text}{' '}
          {n.kind === 'REFRESH' && (
            <button type="button" className="button secondary" onClick={reload}>
              Refresh
            </button>
          )}
          {n.kind === 'SIGN_IN' && <a href="/creator/account">Sign in</a>}
          {n.kind === 'RETRY_SAME_REQUEST' && ' Press the same button again to retry.'}
        </p>
      )}
    </>
  );
}

interface ArtifactRow {
  kind: 'URL_SNAPSHOT' | 'COMMIT' | 'PRIVATE_ARTIFACT';
  ref: string;
  immutableVersion: string;
}
function SubmitForm({
  card,
  available,
  ready,
  runner,
  api,
  reload,
}: {
  card: MyRaidsView['engagements'][number];
  available: boolean;
  ready: boolean;
  runner: ReturnType<typeof useRunner>;
  api: Client;
  reload: () => void;
}) {
  const intent = 'submit:' + card.engagementId;
  const [explanation, setExplanation] = useState('');
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([
    { kind: 'COMMIT', ref: '', immutableVersion: '' },
  ]);
  const [dependencies, setDependencies] = useState('');
  const [aiUsage, setAiUsage] = useState('');
  const [problem, setProblem] = useState('');
  const input = {
    engagementId: card.engagementId,
    expectedSubmissionNumber: card.submissionCount + 1,
    explanation: explanation.trim(),
    artifacts: artifacts.map((a) => ({
      kind: a.kind,
      ref: a.ref.trim(),
      immutableVersion: a.immutableVersion.trim(),
    })),
    dependencies: dependencies
      .split('\n')
      .map((d) => d.trim())
      .filter(Boolean),
    aiUsage: aiUsage.trim() || null,
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = SubmitWorkInput.safeParse(input);
    if (!parsed.success) {
      setProblem(
        'Add an explanation and at least one artifact with a reference and an immutable version (checksum or commit id).',
      );
      return;
    }
    setProblem('');
    void runner.run(
      intent,
      parsed.data,
      (key) => api.submitWork(parsed.data, key),
      intent + '|Submission saved. It is waiting for the reviewer.',
    );
  }
  const disabled = !ready || !available || runner.busy !== null;
  return (
    <form onSubmit={submit} noValidate aria-label={'Submit work for ' + card.title}>
      <h4>{card.submissionCount === 0 ? 'Submit your work' : 'Resubmit your work'}</h4>
      <p className="orientation-hint">
        Submission {card.submissionCount + 1} of at most {card.maxSubmissions}. Each submission is
        saved permanently and reviewed against the original criteria.
      </p>
      {!available && <p role="status">Submitting is currently unavailable.</p>}
      <fieldset className="orientation-fields" disabled={disabled}>
        <legend className="visually-hidden">Work submission</legend>
        <label>
          Explanation
          <textarea
            rows={4}
            maxLength={8000}
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
          />
        </label>
        {artifacts.map((a, i) => (
          <div key={i} role="group" aria-label={'Artifact ' + (i + 1)}>
            <label>
              Artifact {i + 1} type
              <select
                value={a.kind}
                onChange={(e) =>
                  setArtifacts(
                    artifacts.map((x, j) =>
                      j === i ? { ...x, kind: e.target.value as ArtifactRow['kind'] } : x,
                    ),
                  )
                }
              >
                <option value="COMMIT">Source commit</option>
                <option value="URL_SNAPSHOT">URL snapshot</option>
                <option value="PRIVATE_ARTIFACT">Private artifact</option>
              </select>
            </label>
            <label>
              Artifact {i + 1} reference
              <input
                value={a.ref}
                maxLength={500}
                onChange={(e) =>
                  setArtifacts(
                    artifacts.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)),
                  )
                }
              />
            </label>
            <label>
              Artifact {i + 1} immutable version
              <input
                value={a.immutableVersion}
                maxLength={200}
                onChange={(e) =>
                  setArtifacts(
                    artifacts.map((x, j) =>
                      j === i ? { ...x, immutableVersion: e.target.value } : x,
                    ),
                  )
                }
              />
              <span className="orientation-hint">A checksum, commit id or artifact version.</span>
            </label>
            {artifacts.length > 1 && (
              <button
                type="button"
                className="button secondary"
                onClick={() => setArtifacts(artifacts.filter((_, j) => j !== i))}
              >
                Remove artifact {i + 1}
              </button>
            )}
          </div>
        ))}
        {artifacts.length < 5 && (
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              setArtifacts([...artifacts, { kind: 'COMMIT', ref: '', immutableVersion: '' }])
            }
          >
            Add another artifact
          </button>
        )}
        <label>
          Dependencies
          <textarea
            rows={2}
            value={dependencies}
            onChange={(e) => setDependencies(e.target.value)}
          />
          <span className="orientation-hint">One per line. Leave empty if none.</span>
        </label>
        <label>
          AI assistance used
          <textarea
            rows={2}
            maxLength={8000}
            value={aiUsage}
            onChange={(e) => setAiUsage(e.target.value)}
          />
          <span className="orientation-hint">Describe any AI help, or leave empty if none.</span>
        </label>
      </fieldset>
      {problem && <p role="alert">{problem}</p>}
      <Feedback runner={runner} intent={intent} reload={reload} />
      <div className="orientation-actions">
        <button className="button" type="submit" disabled={disabled}>
          {runner.busy === intent ? 'Saving…' : 'Submit work'}
        </button>
      </div>
    </form>
  );
}

function EngagementCard({
  card,
  submissionsAvailable,
  startAvailable,
  ready,
  runner,
  api,
  reload,
}: {
  card: MyRaidsView['engagements'][number];
  submissionsAvailable: boolean;
  startAvailable: boolean;
  ready: boolean;
  runner: ReturnType<typeof useRunner>;
  api: Client;
  reload: () => void;
}) {
  const canSubmit = card.nextStep === 'SUBMIT_WORK' || card.nextStep === 'REVISE_AND_RESUBMIT';
  const canStart = card.nextStep === 'WAIT_FOR_START' && startAvailable;
  const startIntent = 'start:' + card.engagementId;
  return (
    <section className="orientation-card" aria-label={card.title}>
      <h3>{card.title}</h3>
      <p>
        <strong>{STATE_TEXT[card.state]}</strong>.{' '}
        {card.capacityHeld
          ? 'This Raid currently holds your one active Raid slot.'
          : 'This Raid no longer holds your active Raid slot.'}
      </p>
      <p>
        {canStart
          ? 'Setup may be finished. Start work when you are ready; the server checks your reservation and setup.'
          : NEXT_TEXT[card.nextStep]}
      </p>
      <ul>
        <li>
          Submission due{' '}
          <time dateTime={card.deadlines.submission}>{when(card.deadlines.submission)}</time>
        </li>
        <li>
          Review due <time dateTime={card.deadlines.review}>{when(card.deadlines.review)}</time>
        </li>
        <li>
          Closes by{' '}
          <time dateTime={card.deadlines.operationalClosure}>
            {when(card.deadlines.operationalClosure)}
          </time>{' '}
          if nothing is resolved
        </li>
      </ul>
      <p>
        {card.setup.status === 'PENDING'
          ? 'Setup is not finished. Preparation is due '
          : card.setup.status === 'READY'
            ? 'Setup finished. Preparation was due '
            : 'Setup no longer applies. Preparation was due '}
        <time dateTime={card.setup.preparationDeadline}>
          {when(card.setup.preparationDeadline)}
        </time>
        .
      </p>
      <h4>Accepted terms</h4>
      <p style={wrap}>{card.acceptedTerms.scope}</p>
      <ul>
        {card.acceptedTerms.roster.map((m) => (
          <li key={m.participantId} style={wrap}>
            {m.responsibility}
          </li>
        ))}
      </ul>
      <h4>Acceptance criteria</h4>
      <ol>
        {card.criteria.map((c) => (
          <li key={c.index} style={wrap}>
            {c.text}
            {c.result && (
              <>
                {' '}
                — <strong>{c.result === 'MET' ? 'Met' : 'Not met'}</strong>
                {c.evidence ? ': ' + c.evidence : ''}
              </>
            )}
          </li>
        ))}
      </ol>
      {card.latestReview && (
        <div>
          <h4>Latest review</h4>
          <p style={wrap}>{card.latestReview.reason}</p>
          {card.latestReview.revisionDeadline && (
            <p>
              Revision due{' '}
              <time dateTime={card.latestReview.revisionDeadline}>
                {when(card.latestReview.revisionDeadline)}
              </time>
              .
            </p>
          )}
        </div>
      )}
      {card.closure && (
        <div>
          <h4>Closure</h4>
          <p role="status">
            {REASON_TEXT[card.closure.reason]} Closed{' '}
            <time dateTime={card.closure.closedAt}>{when(card.closure.closedAt)}</time>. Closing
            work does not decide payment or fault.
          </p>
          <p>
            {!card.capacityHeld && <strong>Capacity released. </strong>}
            Financial resolution: {card.closure.financialResolution.toLowerCase()}
            {' — '}
            no payout, refund or fault has been decided.
          </p>
          {card.claims.map((c, i) => (
            <p key={i}>
              Reward claim: {units(c.amount, c.policy.verifiedDecimals)} ({c.policy.assetId.kind}) —{' '}
              <strong>unsettled</strong>. Simulated funds; no payment has been made.
            </p>
          ))}
        </div>
      )}
      {canStart && (
        <>
          <Feedback runner={runner} intent={startIntent} reload={reload} />
          <button
            type="button"
            className="button"
            disabled={!ready || runner.busy !== null}
            onClick={() =>
              void runner.run(
                startIntent,
                card.engagementId,
                (key) => api.startEngagement(card.engagementId, key),
                startIntent + '|Work started.',
              )
            }
          >
            Start work
          </button>
          <p className="orientation-hint">
            Starting checks that your reward reservation is still held and that no setup is
            outstanding. It keeps your one active Raid slot.
          </p>
        </>
      )}
      {canSubmit && (
        <SubmitForm
          card={card}
          available={submissionsAvailable}
          ready={ready}
          runner={runner}
          api={api}
          reload={reload}
        />
      )}
    </section>
  );
}

export function MyRaidsWorkspace({
  initial,
  submissionsAvailable,
  applicationsAvailable,
  startAvailable = false,
  api = defaultClient,
}: {
  initial: MyRaidsView;
  submissionsAvailable: boolean;
  applicationsAvailable: boolean;
  startAvailable?: boolean;
  api?: Client;
}) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const [view, setView] = useState(initial);
  const [loadFailure, setLoadFailure] = useState('');
  async function reload() {
    setView(await api.me());
    setLoadFailure('');
  }
  const refresh = () => {
    reload().catch(() => setLoadFailure('The latest view could not be loaded. Try again.'));
  };
  const runner = useRunner(reload);
  return (
    <div className="orientation-layout">
      {!ready && <p role="status">Loading controls…</p>}
      {runner.done && <p role="status">{runner.done}</p>}
      <section aria-labelledby="my-raids-heading">
        <h2 id="my-raids-heading">My Raid</h2>
        <p>
          Active Raid capacity: {view.capacity.held ? 1 : 0} of {view.capacity.limit} in use
          {view.capacity.title ? ' (' + view.capacity.title + ')' : ''}.
        </p>
        {view.engagements.length === 0 && (
          <p>You have no accepted Raids yet. Accepted work will appear here.</p>
        )}
        {view.engagements.map((card) => (
          <EngagementCard
            key={card.engagementId}
            card={card}
            submissionsAvailable={submissionsAvailable}
            startAvailable={startAvailable}
            ready={ready}
            runner={runner}
            api={api}
            reload={refresh}
          />
        ))}
      </section>
      <section aria-labelledby="my-applications-heading">
        <h2 id="my-applications-heading">My applications</h2>
        {view.applications.length === 0 && <p>You have no applications.</p>}
        {view.applications.map((a) => {
          const intent = 'withdraw:' + a.applicationId;
          const usable = a.offer && a.offer.state === 'PENDING' && !a.offer.expired;
          return (
            <section
              className="orientation-card"
              key={a.applicationId}
              aria-label={'Application: ' + a.title}
            >
              <h3>{a.title}</h3>
              <p>Application {a.state.toLowerCase()}. An application is not a commitment.</p>
              {a.offer && (
                <p role="status">
                  {a.offer.state === 'PENDING' && !a.offer.expired
                    ? 'Offer waiting until '
                    : a.offer.state === 'ACCEPTED'
                      ? 'Offer accepted; expiry was '
                      : a.offer.state === 'REVOKED'
                        ? 'Offer withdrawn by the founder; it was valid until '
                        : 'Offer expired; it was valid until '}
                  <time dateTime={a.offer.expiresAt}>{when(a.offer.expiresAt)}</time>.
                </p>
              )}
              {usable && (
                <p className="orientation-hint">
                  Accepting needs your current eligibility and consent, which this host does not
                  supply, so acceptance is not offered here.
                </p>
              )}
              {a.state === 'SUBMITTED' && (
                <>
                  <Feedback runner={runner} intent={intent} reload={refresh} />
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!ready || !applicationsAvailable || runner.busy !== null}
                    onClick={() =>
                      void runner.run(
                        intent,
                        a.applicationId,
                        (key) => api.withdrawApplication(a.applicationId, key),
                        intent + '|Application withdrawn.',
                      )
                    }
                  >
                    Withdraw application
                  </button>
                  {!applicationsAvailable && (
                    <p role="status">Withdrawing is currently unavailable.</p>
                  )}
                </>
              )}
            </section>
          );
        })}
      </section>
      {loadFailure && <p role="alert">{loadFailure}</p>}
    </div>
  );
}

type Verdict = 'ACCEPT' | 'REQUEST_REVISION' | 'DISPUTE';
function ReviewForm({
  item,
  available,
  ready,
  runner,
  api,
  reload,
}: {
  item: ReviewQueueView['items'][number];
  available: boolean;
  ready: boolean;
  runner: ReturnType<typeof useRunner>;
  api: Client;
  reload: () => void;
}) {
  const intent = 'review:' + item.submissionId;
  const [decision, setDecision] = useState<Verdict>('ACCEPT');
  const [reason, setReason] = useState('');
  const [results, setResults] = useState(
    item.criteria.map(() => ({ result: 'MET', evidence: '' })),
  );
  const [deadline, setDeadline] = useState('');
  const [problem, setProblem] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    const revisionDeadline =
      decision === 'REQUEST_REVISION' && deadline ? new Date(deadline + ':00Z') : null;
    const parsed = DecideReviewInput.safeParse({
      submissionId: item.submissionId,
      decision,
      reason: reason.trim(),
      criteria: item.criteria.map((c, i) => ({
        index: c.index,
        result: results[i].result,
        evidence: results[i].evidence.trim() || null,
      })),
      revisionDeadline:
        revisionDeadline && !Number.isNaN(revisionDeadline.getTime())
          ? revisionDeadline.toISOString()
          : null,
    });
    if (!parsed.success) {
      setProblem(
        decision === 'ACCEPT'
          ? 'Acceptance needs every criterion met and a reason.'
          : decision === 'REQUEST_REVISION'
            ? 'A revision needs a reason, at least one unmet criterion and a UTC deadline.'
            : 'A dispute needs a reason and at least one unmet criterion.',
      );
      return;
    }
    setProblem('');
    void runner.run(
      intent,
      parsed.data,
      (key) => api.decideReview(parsed.data, key),
      intent + '|Decision saved.',
    );
  }
  const disabled = !ready || !available || runner.busy !== null;
  return (
    <section className="orientation-card" aria-label={'Review: ' + item.title}>
      <h3>{item.title}</h3>
      <p>
        Submission {item.submissionNumber}, saved{' '}
        <time dateTime={item.submittedAt}>{when(item.submittedAt)}</time>. Review due{' '}
        <time dateTime={item.reviewDue}>{when(item.reviewDue)}</time>. {item.revisionsRemaining}{' '}
        revision request{item.revisionsRemaining === 1 ? '' : 's'} remaining.
      </p>
      <h4>Explanation</h4>
      <p style={wrap}>{item.explanation}</p>
      <h4>Artifacts</h4>
      <ul>
        {item.artifacts.map((a, i) => (
          <li key={i} style={wrap}>
            {a.kind}: {a.ref} @ {a.immutableVersion}
          </li>
        ))}
      </ul>
      {item.dependencies.length > 0 && (
        <p style={wrap}>Dependencies: {item.dependencies.join('; ')}</p>
      )}
      <p style={wrap}>AI assistance: {item.aiUsage ?? 'none disclosed'}</p>
      <form onSubmit={submit} noValidate aria-label={'Decide: ' + item.title}>
        <h4>Your decision</h4>
        {!available && <p role="status">Recording decisions is currently unavailable.</p>}
        <fieldset className="orientation-fields" disabled={disabled}>
          <legend className="visually-hidden">Review decision</legend>
          <label>
            Decision
            <select value={decision} onChange={(e) => setDecision(e.target.value as Verdict)}>
              <option value="ACCEPT">Accept the work</option>
              <option value="REQUEST_REVISION" disabled={item.revisionsRemaining === 0}>
                Request a revision
              </option>
              <option value="DISPUTE">Raise a dispute</option>
            </select>
          </label>
          {item.criteria.map((c, i) => (
            <div key={c.index} role="group" aria-label={'Criterion ' + (i + 1)}>
              <p style={wrap}>
                Criterion {i + 1}: {c.text}
              </p>
              <label>
                Result for criterion {i + 1}
                <select
                  value={results[i].result}
                  onChange={(e) =>
                    setResults(
                      results.map((r, j) => (j === i ? { ...r, result: e.target.value } : r)),
                    )
                  }
                >
                  <option value="MET">Met</option>
                  <option value="UNMET">Not met</option>
                </select>
              </label>
              <label>
                Evidence for criterion {i + 1}
                <input
                  maxLength={2000}
                  value={results[i].evidence}
                  onChange={(e) =>
                    setResults(
                      results.map((r, j) => (j === i ? { ...r, evidence: e.target.value } : r)),
                    )
                  }
                />
              </label>
            </div>
          ))}
          <label>
            Reason
            <textarea
              rows={3}
              maxLength={8000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {decision === 'REQUEST_REVISION' && (
            <label>
              Revision deadline (UTC)
              <input
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
              <span className="orientation-hint">
                Must be in the future and before the operational closure.
              </span>
            </label>
          )}
        </fieldset>
        {problem && <p role="alert">{problem}</p>}
        <Feedback runner={runner} intent={intent} reload={reload} />
        <div className="orientation-actions">
          <button className="button" type="submit" disabled={disabled}>
            {runner.busy === intent ? 'Saving…' : 'Record decision'}
          </button>
        </div>
      </form>
    </section>
  );
}
function OfferControls({
  applicant,
  available,
  ready,
  runner,
  api,
  reload,
}: {
  applicant: ApplicantQueueView['listings'][number]['applicants'][number];
  available: boolean;
  ready: boolean;
  runner: ReturnType<typeof useRunner>;
  api: Client;
  reload: () => void;
}) {
  const [expires, setExpires] = useState('');
  const [problem, setProblem] = useState('');
  const issueIntent = 'offer:' + applicant.applicationId;
  const revokeIntent = 'revoke:' + applicant.applicationId;
  const disabled = !ready || !available || runner.busy !== null;
  const live = applicant.offer && applicant.offer.state === 'PENDING' && !applicant.offer.expired;
  function issue(event: FormEvent) {
    event.preventDefault();
    const at = new Date(expires + ':00Z');
    if (!expires || Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      setProblem('Choose a future UTC expiry.');
      return;
    }
    setProblem('');
    const input = { applicationId: applicant.applicationId, expiresAt: at.toISOString() };
    void runner.run(
      issueIntent,
      input,
      (key) => api.issueOffer(input, key),
      issueIntent + '|Offer issued. It does not reserve time, funds or capacity.',
    );
  }
  return (
    <div>
      {applicant.offer && (
        <p role="status">
          Offer {applicant.offer.state.toLowerCase()}
          {applicant.offer.expired && applicant.offer.state === 'PENDING' ? ' (expired)' : ''},
          valid until{' '}
          <time dateTime={applicant.offer.expiresAt}>{when(applicant.offer.expiresAt)}</time>.
        </p>
      )}
      {live ? (
        <>
          <Feedback runner={runner} intent={revokeIntent} reload={reload} />
          <button
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() =>
              void runner.run(
                revokeIntent,
                applicant.offer!.offerId,
                (key) => api.revokeOffer(applicant.offer!.offerId, key),
                revokeIntent + '|Offer revoked.',
              )
            }
          >
            Revoke offer
          </button>
        </>
      ) : (
        <form
          onSubmit={issue}
          noValidate
          aria-label={'Offer for application ' + applicant.applicationId}
        >
          <fieldset className="orientation-fields" disabled={disabled}>
            <legend className="visually-hidden">Issue offer</legend>
            <label>
              Offer expires (UTC)
              <input
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </label>
          </fieldset>
          {problem && <p role="alert">{problem}</p>}
          <Feedback runner={runner} intent={issueIntent} reload={reload} />
          <button className="button" type="submit" disabled={disabled}>
            Issue offer
          </button>
        </form>
      )}
    </div>
  );
}

export function WorkDesk({
  initialReviews,
  initialApplicants,
  reviewsAvailable,
  offersAvailable,
  api = defaultClient,
}: {
  initialReviews: ReviewQueueView;
  initialApplicants: ApplicantQueueView;
  reviewsAvailable: boolean;
  offersAvailable: boolean;
  api?: Client;
}) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const [reviews, setReviews] = useState(initialReviews);
  const [applicants, setApplicants] = useState(initialApplicants);
  const [loadFailure, setLoadFailure] = useState('');
  async function reload() {
    const [r, a] = await Promise.all([api.reviews(), api.applicants()]);
    setReviews(r);
    setApplicants(a);
    setLoadFailure('');
  }
  const refresh = () => {
    reload().catch(() => setLoadFailure('The latest view could not be loaded. Try again.'));
  };
  const runner = useRunner(reload);
  return (
    <div className="orientation-layout">
      {!ready && <p role="status">Loading controls…</p>}
      {runner.done && <p role="status">{runner.done}</p>}
      <section aria-labelledby="review-queue-heading">
        <h2 id="review-queue-heading">Submissions to review</h2>
        {reviews.items.length === 0 && <p>No submissions are waiting for you.</p>}
        {reviews.items.map((item) => (
          <ReviewForm
            key={item.submissionId}
            item={item}
            available={reviewsAvailable}
            ready={ready}
            runner={runner}
            api={api}
            reload={refresh}
          />
        ))}
      </section>
      <section aria-labelledby="applicant-queue-heading">
        <h2 id="applicant-queue-heading">Applicants</h2>
        {applicants.listings.length === 0 && <p>No applicants on listings you manage.</p>}
        {applicants.listings.map((listing) => (
          <section
            className="orientation-card"
            key={listing.slotId}
            aria-label={'Listing: ' + listing.title}
          >
            <h3>{listing.title}</h3>
            {listing.applicants.map((a) => (
              <div key={a.applicationId} role="group" aria-label={'Applicant ' + a.applicationId}>
                <p>
                  Applied <time dateTime={a.appliedAt}>{when(a.appliedAt)}</time>.
                </p>
                <p style={wrap}>
                  Evidence: {a.evidenceRefs.length ? a.evidenceRefs.join(', ') : 'none provided'}
                </p>
                <OfferControls
                  applicant={a}
                  available={offersAvailable}
                  ready={ready}
                  runner={runner}
                  api={api}
                  reload={refresh}
                />
              </div>
            ))}
          </section>
        ))}
      </section>
      {loadFailure && <p role="alert">{loadFailure}</p>}
    </div>
  );
}
