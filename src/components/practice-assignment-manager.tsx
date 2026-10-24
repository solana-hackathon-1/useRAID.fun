'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PracticeAssignmentManagementContext } from '../skills/practice-review-assignment-management-contracts';
import {
  PracticeReviewAssignmentIssueResultSchema,
  PracticeReviewAssignmentRevokeResultSchema,
} from '../skills/practice-review-assignment-contracts';
import {
  createPracticeAssignmentManager,
  type AssignmentManagerTransport,
} from '../skills/practice-assignment-manager-client';
const subscribeReady = () => () => {};
const clientReady = () => true,
  serverReady = () => false;
const wrap = { overflowWrap: 'anywhere' } as const;
const utc = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value)) + ' UTC';
/** Stateless host authorization is required before mounting; controller never supplies server authority. */
export function PracticeAssignmentManager({
  context,
  transport,
}: {
  context: PracticeAssignmentManagementContext;
  transport?: AssignmentManagerTransport;
}) {
  const [manager] = useState(() => createPracticeAssignmentManager(context, transport));
  const state = useSyncExternalStore(manager.subscribe, manager.snapshot, manager.snapshot),
    ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const [lookup, setLookup] = useState(context.page.submissionId ?? ''),
    [submission, setSubmission] = useState(context.page.submissionId ?? ''),
    [evaluator, setEvaluator] = useState(''),
    [purpose, setPurpose] = useState('OWNERSHIP_REVIEW'),
    [expiry, setExpiry] = useState(''),
    [reason, setReason] = useState(''),
    [revokeId, setRevokeId] = useState(''),
    [revokeReason, setRevokeReason] = useState('');
  const pending = ['BUSY', 'UNCERTAIN', 'BLOCKED'].includes(state.phase),
    locked = pending || state.phase === 'LOADING';
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);
  const refresh = (target = lookup, after: string | null = null) => {
    setRevokeId('');
    void manager.load({ version: 'v1', submissionId: target.trim() || null, after });
  };
  if (!state.context)
    return (
      <section className="orientation-card">
        <p role="alert">{state.message}</p>
        <button className="button secondary" disabled={!ready} onClick={() => refresh()}>
          Recheck management access
        </button>
      </section>
    );
  const c = state.context,
    canWrite = ready && state.phase === 'EDITING' && c.writesAvailable;
  const savedIssue =
    state.outcome?.kind === 'ISSUE'
      ? PracticeReviewAssignmentIssueResultSchema.safeParse(state.outcome.body)
      : null;
  const savedRevoke =
    state.outcome?.kind === 'REVOKE'
      ? PracticeReviewAssignmentRevokeResultSchema.safeParse(state.outcome.body)
      : null;
  return (
    <div className="stack" style={wrap}>
      <p>
        Manage a specific submission’s finite review appointments. Each change rechecks your current
        administrator authority. Appointments do not verify skills or supply administrator access.
      </p>
      <form
        className="orientation-card"
        onSubmit={(event) => {
          event.preventDefault();
          refresh();
        }}
      >
        <h2>Find appointments</h2>
        <fieldset className="orientation-fields" disabled={!ready || locked}>
          <legend>Submission lookup</legend>
          <label htmlFor="manager-lookup">Find submission ID</label>
          <input
            id="manager-lookup"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="Submission UUID"
          />
          <p>
            Use an existing submission identifier from your authorized case workflow. Leaving it
            blank opens a new lookup.
          </p>
          <button className="button" type="submit">
            Lookup appointments
          </button>
        </fieldset>
      </form>
      {state.message && <p role={state.phase === 'SAVED' ? 'status' : 'alert'}>{state.message}</p>}
      {state.phase === 'UNCERTAIN' && (
        <button className="button" onClick={() => void manager.retry()}>
          Retry same request
        </button>
      )}
      {(state.phase === 'UNCERTAIN' || state.phase === 'BLOCKED') && (
        <button
          className="button secondary"
          onClick={() => {
            // Re-entering the command is deliberate: a discarded write must not be re-sent by one click.
            setRevokeId('');
            setEvaluator('');
            setExpiry('');
            setReason('');
            setRevokeReason('');
            void manager.discard();
          }}
        >
          Discard request and recheck
        </button>
      )}
      {state.outcome && (
        <section className="orientation-card" aria-label="Saved historical receipt">
          <h2>Saved historical receipt</h2>
          <p>This is the original command result. Refresh to observe current access.</p>
          {savedIssue?.success && (
            <p>
              Issued appointment <code>{savedIssue.data.assignment.id}</code> at{' '}
              {utc(savedIssue.data.assignment.issuedAt)}.
            </p>
          )}
          {savedRevoke?.success && (
            <p>
              Revocation <code>{savedRevoke.data.revocation.id}</code> for appointment{' '}
              <code>{savedRevoke.data.revocation.assignmentId}</code>, recorded{' '}
              {utc(savedRevoke.data.revocation.revokedAt)}.
            </p>
          )}
        </section>
      )}
      {!c.writesAvailable && (
        <p role="status">
          New appointment changes are disabled. Current history remains available.
        </p>
      )}
      <section className="orientation-card" aria-label="Appointment observation">
        <h2>
          {state.phase === 'SAVED' ? 'Appointments observed before save' : 'Appointments observed'}
        </h2>
        <p>
          Observed <time dateTime={c.page.observedAt}>{utc(c.page.observedAt)}</time>. This
          observation is not a permission lease.
        </p>
        {c.page.submissionId ? (
          <p>
            Submission <code>{c.page.submissionId}</code>
          </p>
        ) : (
          <p>Look up a submission to inspect its current appointments.</p>
        )}
        {c.page.entries.length === 0 ? (
          <p>
            No appointments on this page. Missing or unavailable submissions also return an empty
            list.
          </p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {c.page.entries.map((entry) => (
              <li
                className="panel stack"
                key={entry.assignment.id}
                style={{ padding: 20, minWidth: 0 }}
              >
                <h3>
                  {entry.assignment.purpose === 'OWNERSHIP_REVIEW'
                    ? 'Ownership review'
                    : 'Skill assessment'}{' '}
                  · {entry.currentState}
                </h3>
                <p>
                  Appointment <code>{entry.assignment.id}</code>
                </p>
                <p>
                  Evaluator <code>{entry.assignment.evaluatorAccountId}</code>
                </p>
                <p>
                  Issued {utc(entry.assignment.issuedAt)} by{' '}
                  <code>{entry.assignment.issuedByAccountId}</code>. Expires{' '}
                  {utc(entry.assignment.expiresAt)}.
                </p>
                <p>{entry.assignment.reason}</p>
                <p>
                  Original appointment record: {entry.assignment.state}. Current observation:{' '}
                  {entry.currentState}.
                </p>
                {entry.revocation && (
                  <>
                    <p>
                      Revoked {utc(entry.revocation.revokedAt)} by{' '}
                      <code>{entry.revocation.revokedByAccountId}</code>.
                    </p>
                    <p>{entry.revocation.reason}</p>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {c.page.nextCursor && (
          <button
            className="button secondary"
            disabled={!ready || locked}
            onClick={() => refresh(c.page.submissionId ?? '', c.page.nextCursor)}
          >
            More appointments
          </button>
        )}
        <button
          className="button secondary"
          disabled={!ready || locked}
          onClick={() => {
            setRevokeId('');
            void manager.refresh();
          }}
        >
          Refresh current appointments
        </button>
      </section>
      <form
        className="orientation-card"
        onSubmit={(event) => {
          event.preventDefault();
          let expiresAt = expiry;
          try {
            expiresAt = new Date(expiry + 'Z').toISOString();
          } catch {
            /* Canonical validation provides the visible error. */
          }
          const submissionId = c.page.submissionId ?? submission;
          setLookup(submissionId);
          void manager.issue({
            submissionId,
            evaluatorAccountId: evaluator,
            purpose,
            expiresAt,
            reason,
          });
        }}
      >
        <h2>New appointment</h2>
        <fieldset className="orientation-fields" disabled={!canWrite}>
          <legend>Explicit finite appointment</legend>
          <label htmlFor="manager-submission">Submission ID for new appointment</label>
          <input
            id="manager-submission"
            value={c.page.submissionId ?? submission}
            readOnly={c.page.submissionId !== null}
            onChange={(e) => setSubmission(e.target.value)}
            required
          />
          <label htmlFor="manager-evaluator">Evaluator account ID</label>
          <input
            id="manager-evaluator"
            value={evaluator}
            onChange={(e) => setEvaluator(e.target.value)}
            maxLength={200}
            required
          />
          <label htmlFor="manager-purpose">Review purpose</label>
          <select id="manager-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="OWNERSHIP_REVIEW">Ownership review</option>
            <option value="ASSESSMENT_REVIEW">Skill assessment</option>
          </select>
          <label htmlFor="manager-expiry">Expiry (UTC)</label>
          <input
            id="manager-expiry"
            type="datetime-local"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            required
          />
          <p>Enter the expiry in UTC. No appointment duration is selected for you.</p>
          <label htmlFor="manager-reason">Appointment reason</label>
          <textarea
            id="manager-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={2000}
            required
          />
          <button className="button" type="submit">
            Issue appointment
          </button>
        </fieldset>
      </form>
      <form
        className="orientation-card"
        onSubmit={(event) => {
          event.preventDefault();
          void manager.revoke(revokeId, revokeReason);
        }}
      >
        <h2>Revoke appointment</h2>
        <p>
          Removes this appointment’s future access. It cannot recall material already disclosed.
        </p>
        <fieldset className="orientation-fields" disabled={!canWrite}>
          <legend>Reasoned revocation</legend>
          <label htmlFor="manager-revoke-id">Appointment to revoke</label>
          <select
            id="manager-revoke-id"
            value={revokeId}
            onChange={(e) => setRevokeId(e.target.value)}
            required
          >
            <option value="">Choose an observed appointment</option>
            {c.page.entries.map((entry) => (
              <option
                value={entry.assignment.id}
                key={entry.assignment.id}
                disabled={entry.currentState === 'REVOKED'}
              >
                {entry.assignment.evaluatorAccountId} · {entry.assignment.purpose} ·{' '}
                {entry.assignment.id} · {entry.currentState}
              </option>
            ))}
          </select>
          <label htmlFor="manager-revoke-reason">Revocation reason</label>
          <textarea
            id="manager-revoke-reason"
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            rows={3}
            maxLength={2000}
            required
          />
          <button className="button secondary" type="submit">
            Revoke appointment
          </button>
        </fieldset>
      </form>
    </div>
  );
}
