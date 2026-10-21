'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createOwnershipEditor, type OwnershipWrite } from '../skills/practice-ownership-client';
import type { PracticeOwnershipContext } from '../skills/practice-ownership-context';
import { PracticeReviewCase } from './practice-review-case';
const wrap = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
export function PracticeOwnershipEditor({
  context,
  write,
  recheck = () => window.location.reload(),
}: {
  context: PracticeOwnershipContext;
  write?: OwnershipWrite;
  recheck?: () => void;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [editor] = useState(() => createOwnershipEditor(context, write));
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [observations, setObservations] = useState([{ kind: 'EXPLANATION', detail: '' }]);
  const pending = ['BUSY', 'UNCERTAIN', 'BLOCKED'].includes(state.phase);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);
  if (!state.context)
    return (
      <section>
        <p role="alert">{state.message}</p>
        <button className="button" onClick={recheck}>
          Recheck access
        </button>
      </section>
    );
  const c = state.context;
  return (
    <div style={wrap}>
      <p>This finding does not verify a rank, decide fraud guilt or grant access.</p>
      <section
        className="orientation-card"
        aria-label={
          c.ownership && !c.ownership.isCurrent
            ? 'Saved finding (historical)'
            : 'Current ownership finding'
        }
      >
        <h2>
          {c.ownership && !c.ownership.isCurrent
            ? 'Saved finding (historical)'
            : 'Current ownership finding'}
        </h2>
        {c.ownership && !c.ownership.isCurrent && (
          <p>A newer finding exists. Recheck the current case before another decision.</p>
        )}
        {c.ownership ? (
          <>
            <p>
              {c.ownership.record.ownership} · version {c.ownership.record.reference.revision}
            </p>
            <p>{c.ownership.record.reason}</p>
            <ul>
              {c.ownership.record.observations.map((o, i) => (
                <li key={i}>
                  {o.kind}: {o.detail}
                </li>
              ))}
            </ul>
            <p>
              Recorded by {c.ownership.record.evaluatorAccountId} under policy{' '}
              {c.ownership.record.policyReference.recordId}, version{' '}
              {c.ownership.record.policyReference.revision}.
            </p>
          </>
        ) : (
          <p>
            No ownership finding recorded. The original submission declaration is not a finding.
          </p>
        )}
      </section>
      <section className="orientation-card" aria-label="Approved ownership policy">
        <h2>Approved ownership policy</h2>
        {c.policy ? (
          <>
            <p>
              Policy {c.policy.policy.reference.recordId}, version{' '}
              {c.policy.policy.reference.revision}.
            </p>
            <p>{c.policy.policy.guidance}</p>
          </>
        ) : (
          <p>No approved policy is available. A new finding cannot be recorded.</p>
        )}
      </section>
      {state.phase === 'READ_ONLY' && !c.writesAvailable && (
        <p role="status">New findings are disabled. Current findings remain evidence only.</p>
      )}
      {state.message && <p role={state.phase === 'SAVED' ? 'status' : 'alert'}>{state.message}</p>}
      {state.phase === 'UNCERTAIN' && (
        <button className="button" onClick={() => void editor.retry()}>
          Retry same request
        </button>
      )}
      {['EDITING', 'BUSY'].includes(state.phase) && (
        <form
          className="orientation-card"
          onSubmit={(event) => {
            event.preventDefault();
            void editor.save({ decision, reason, observations });
          }}
        >
          <h2>Record ownership finding</h2>
          <fieldset className="orientation-fields" disabled={!ready || state.phase !== 'EDITING'}>
            <legend>Reasoned finding</legend>
            <label htmlFor="ownership-decision">Finding</label>
            <select
              id="ownership-decision"
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
              required
            >
              <option value="">Choose a finding</option>
              <option value="CONFIRM">Confirm ownership</option>
              <option value="DISPUTE">Dispute ownership</option>
              <option value="MORE_EVIDENCE">Request more evidence</option>
            </select>
            <label htmlFor="ownership-reason">Reason</label>
            <textarea
              id="ownership-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              maxLength={2000}
              rows={4}
            />
            {observations.map((observation, index) => (
              <div className="orientation-fields" style={{ margin: 0 }} key={index}>
                <label htmlFor={'observation-kind-' + index}>Observation {index + 1} type</label>
                <select
                  id={'observation-kind-' + index}
                  value={observation.kind}
                  onChange={(e) =>
                    setObservations((items) =>
                      items.map((o, i) => (i === index ? { ...o, kind: e.target.value } : o)),
                    )
                  }
                >
                  <option value="EXPLANATION">Explanation</option>
                  <option value="MODIFICATION">Modification</option>
                  <option value="ATTRIBUTION">Attribution</option>
                  <option value="OTHER">Other</option>
                </select>
                <label htmlFor={'observation-detail-' + index}>Observation {index + 1}</label>
                <textarea
                  id={'observation-detail-' + index}
                  value={observation.detail}
                  onChange={(e) =>
                    setObservations((items) =>
                      items.map((o, i) => (i === index ? { ...o, detail: e.target.value } : o)),
                    )
                  }
                  required
                  maxLength={2000}
                  rows={3}
                />
                {observations.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setObservations((items) => items.filter((_, i) => i !== index))}
                  >
                    Remove observation {index + 1}
                  </button>
                )}
              </div>
            ))}
            <div className="orientation-actions">
              <button
                className="button secondary"
                type="button"
                disabled={observations.length >= 20}
                onClick={() =>
                  setObservations((items) => [...items, { kind: 'OTHER', detail: '' }])
                }
              >
                Add observation
              </button>
              <button className="button" type="submit">
                {state.phase === 'BUSY' ? 'Saving…' : 'Save finding'}
              </button>
            </div>
          </fieldset>
          <p>
            A save uses the policy and finding versions shown here. Keep this page open if its
            outcome is uncertain; retry the same request.
          </p>
        </form>
      )}
      <button
        type="button"
        className="button secondary"
        onClick={recheck}
        disabled={!ready || pending}
      >
        Recheck current case
      </button>
      <PracticeReviewCase review={c.review} actionsAvailable />
    </div>
  );
}
