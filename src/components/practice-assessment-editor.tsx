'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  createAssessmentEditor,
  canReviewAssessment,
  canDecideAssessment,
  type AssessmentWrite,
  type AssessmentSaved,
} from '../skills/practice-assessment-client';
import type { PracticeAssessmentContext } from '../skills/practice-assessment-context';
import { PracticeReviewCase } from './practice-review-case';
const subscribeReady = () => () => {};
const readySnapshot = () => true;
const serverReadySnapshot = () => false;
const wrap = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
export function SavedAssessmentResult({ saved }: { saved: AssessmentSaved }) {
  const v = saved.view;
  if (!v) return null;
  if (saved.kind === 'review') {
    const r = saved.view!;
    return (
      <section className="orientation-card" aria-label="Saved assessment">
        <h2>{r.isCurrentReview ? 'Saved assessment review' : 'Saved review (historical)'}</h2>
        <p>Recheck to refresh the source context and policy shown above.</p>
        {!r.isCurrentReview && <p>A newer review exists. Recheck the current case.</p>}
        <p>
          {r.review.decision} · review version {r.review.reference.revision}
        </p>
        <p>{r.review.reason}</p>
        {r.assessment && (
          <p>
            Saved skill state: {r.assessment.state}, rank {r.assessment.assessedRank}, version{' '}
            {r.assessment.reference.revision}
            {!r.isCurrentAssessment ? ' (historical)' : ''}.
          </p>
        )}
      </section>
    );
  }
  const d = saved.view!;
  return (
    <section className="orientation-card" aria-label="Saved assessment">
      <h2>{d.isCurrent ? 'Saved assessment decision' : 'Saved decision (historical)'}</h2>
      <p>Recheck to refresh the source context and policy shown above.</p>
      {!d.isCurrent && <p>A newer assessment exists. Recheck the current case.</p>}
      <p>
        {d.assessment.state} · version {d.assessment.reference.revision}
      </p>
      <p>{d.decision.reason}</p>
      <ul>
        {d.decision.findings.map((f, i) => (
          <li key={i}>
            {f.kind}: {f.detail}
          </li>
        ))}
      </ul>
    </section>
  );
}
export function PracticeAssessmentEditor({
  context,
  write,
  recheck = () => window.location.reload(),
}: {
  context: PracticeAssessmentContext;
  write?: AssessmentWrite;
  recheck?: () => void;
}) {
  const ready = useSyncExternalStore(subscribeReady, readySnapshot, serverReadySnapshot);
  const [editor] = useState(() => createAssessmentEditor(context, write));
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [confidence, setConfidence] = useState('');
  const [reassessmentAt, setReassessmentAt] = useState('');
  const [criteria, setCriteria] = useState(() =>
    context.review.definition.rubric.criteria.map((c) => ({
      criterionId: c.id,
      result: '',
      reason: '',
    })),
  );
  const [action, setAction] = useState('');
  const [caseReason, setCaseReason] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [findings, setFindings] = useState([{ kind: 'CAPABILITY_EVIDENCE', detail: '' }]);
  const pending = ['BUSY', 'UNCERTAIN', 'BLOCKED'].includes(state.phase);
  useEffect(() => {
    if (!pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);
  if (!state.context)
    return (
      <section>
        <p role={state.phase === 'SAVED' ? 'status' : 'alert'}>{state.message}</p>
        <button className="button" onClick={recheck}>
          Recheck access
        </button>
      </section>
    );
  const c = state.context,
    r = c.review,
    d = r.definition,
    a = c.assessmentState?.assessment;
  const observed = state.phase === 'SAVED' ? 'Observed before save: ' : '';
  const supported =
    d.targetRank !== 'S' &&
    d.evaluatorMethod === 'MANUAL' &&
    c.ownership?.record.ownership === 'CONFIRMED';
  const editable = ['EDITING', 'BUSY'].includes(state.phase);
  return (
    <div style={wrap}>
      <p>
        An assessment records demonstrated skill under the original rubric. It creates no private
        access, work slot or payment.
      </p>
      <section className="orientation-card" aria-label="Current assessment context">
        <h2>{observed}Current assessment context</h2>
        <p>
          Current ownership finding:{' '}
          {c.ownership
            ? c.ownership.record.ownership + ' · version ' + c.ownership.record.reference.revision
            : 'None recorded'}
          .
        </p>
        {c.ownership && <p>{c.ownership.record.reason}</p>}
        <p>
          {c.assessmentReview
            ? 'Current case review: ' +
              c.assessmentReview.review.decision +
              ' · version ' +
              c.assessmentReview.review.reference.revision
            : 'No assessment review recorded for this case.'}
        </p>
        {c.assessmentReview && <p>{c.assessmentReview.review.reason}</p>}
        {a ? (
          <>
            <p>
              Current skill state: {a.state} · rank {a.assessedRank} · version{' '}
              {a.reference.revision}.
            </p>
            <p>
              {a.confidenceStatement} · sample size {a.sampleSize}.
            </p>
            {a.reassessmentAt && <p>Reassessment due (UTC): {a.reassessmentAt}</p>}
          </>
        ) : (
          <p>No current skill assessment is available for this case.</p>
        )}
      </section>
      <section className="orientation-card" aria-label="Approved assessment policy">
        <h2>{observed}Approved assessment policy</h2>
        {c.policy ? (
          <>
            <p>
              Policy {c.policy.policy.reference.recordId}, version{' '}
              {c.policy.policy.reference.revision}.
            </p>
            <p>{c.policy.policy.guidance}</p>
          </>
        ) : (
          <p>No approved policy is available. New assessment actions cannot be recorded.</p>
        )}
      </section>
      {state.phase === 'READ_ONLY' && c.policy && (
        <p role="status">New assessment actions are disabled for this case.</p>
      )}
      {state.message && <p role={state.phase === 'SAVED' ? 'status' : 'alert'}>{state.message}</p>}
      {state.saved && <SavedAssessmentResult saved={state.saved} />}
      {state.phase === 'UNCERTAIN' && (
        <button className="button" onClick={() => void editor.retry()}>
          Retry same request
        </button>
      )}
      {editable && canReviewAssessment(c) && (
        <form
          className="orientation-card"
          onSubmit={(e) => {
            e.preventDefault();
            void editor.save('review', {
              decision,
              reason,
              confidenceStatement: confidence,
              criteria,
              reassessmentAt: reassessmentAt || null,
            });
          }}
        >
          <h2>Record assessment review</h2>
          <p>
            Verification requires confirmed ownership, every required criterion met and supported
            evidence. Requesting more evidence or recording that skill was not demonstrated
            preserves any existing assessment.
          </p>
          {!supported && (
            <p>
              Verification is unavailable without current confirmed ownership and supported manual
              evidence. S rank requires additional independent evidence; automated result sources
              are not available here.
            </p>
          )}
          <fieldset className="orientation-fields" disabled={!ready || state.phase !== 'EDITING'}>
            <legend>Reasoned assessment review</legend>
            <label htmlFor="assessment-decision">Review outcome</label>
            <select
              id="assessment-decision"
              required
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
            >
              <option value="">Choose an outcome</option>
              <option value="VERIFY" disabled={!supported}>
                Verify demonstrated skill
              </option>
              <option value="MORE_EVIDENCE">Request more evidence</option>
              <option value="NOT_DEMONSTRATED">Skill not demonstrated</option>
            </select>
            <label htmlFor="assessment-reason">Review reason</label>
            <textarea
              id="assessment-reason"
              required
              maxLength={2000}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <label htmlFor="assessment-confidence">Confidence statement</label>
            <textarea
              id="assessment-confidence"
              required
              maxLength={2000}
              rows={3}
              value={confidence}
              onChange={(e) => setConfidence(e.target.value)}
            />
            {d.rubric.criteria.map((criterion, index) => (
              <div className="orientation-fields" style={{ margin: 0 }} key={criterion.id}>
                <p>
                  {criterion.description}
                  {criterion.required ? ' (required)' : ''}
                </p>
                <label htmlFor={'assessment-result-' + index}>Criterion {index + 1} result</label>
                <select
                  id={'assessment-result-' + index}
                  required
                  value={criteria[index].result}
                  onChange={(e) =>
                    setCriteria((xs) =>
                      xs.map((x, i) => (i === index ? { ...x, result: e.target.value } : x)),
                    )
                  }
                >
                  <option value="">Choose a result</option>
                  <option value="MET">Met</option>
                  <option value="NOT_MET">Not met</option>
                  <option value="UNCERTAIN">Uncertain</option>
                </select>
                <label htmlFor={'assessment-criterion-' + index}>
                  Criterion {index + 1} reason
                </label>
                <textarea
                  id={'assessment-criterion-' + index}
                  required
                  maxLength={2000}
                  rows={3}
                  value={criteria[index].reason}
                  onChange={(e) =>
                    setCriteria((xs) =>
                      xs.map((x, i) => (i === index ? { ...x, reason: e.target.value } : x)),
                    )
                  }
                />
              </div>
            ))}
            <label htmlFor="assessment-date">Optional reassessment date (UTC)</label>
            <input
              id="assessment-date"
              type="text"
              placeholder="2026-12-01T00:00:00.000Z"
              value={reassessmentAt}
              onChange={(e) => setReassessmentAt(e.target.value)}
            />
            <button className="button" type="submit">
              Save assessment review
            </button>
          </fieldset>
        </form>
      )}
      {editable && canDecideAssessment(c) && (
        <form
          className="orientation-card"
          onSubmit={(e) => {
            e.preventDefault();
            void editor.save('decisions', {
              action,
              reasonCategory:
                action === 'REVOKE' ? 'FRAUDULENT_ASSESSMENT_EVIDENCE' : 'CAPABILITY_RECHECK',
              reason: caseReason,
              findings,
              dueAt: action === 'REVOKE' ? null : dueAt,
            });
          }}
        >
          <h2>Record assessment state decision</h2>
          <p>
            Use specific reviewed evidence under the approved policy. Similarity or AI signals alone
            do not establish fraud.
          </p>
          <fieldset className="orientation-fields" disabled={!ready || state.phase !== 'EDITING'}>
            <legend>Reasoned state decision</legend>
            <label htmlFor="assessment-action">State action</label>
            <select
              id="assessment-action"
              required
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              <option value="">Choose an action</option>
              <option value="REQUIRE_REASSESSMENT" disabled={a?.state !== 'VERIFIED'}>
                Require capability reassessment
              </option>
              <option value="REVOKE">Revoke for fraudulent assessment evidence</option>
            </select>
            <label htmlFor="assessment-case-reason">State decision reason</label>
            <textarea
              id="assessment-case-reason"
              required
              maxLength={2000}
              rows={3}
              value={caseReason}
              onChange={(e) => setCaseReason(e.target.value)}
            />
            {findings.map((f, index) => (
              <div className="orientation-fields" style={{ margin: 0 }} key={index}>
                <label htmlFor={'assessment-kind-' + index}>Finding {index + 1} type</label>
                <select
                  id={'assessment-kind-' + index}
                  value={f.kind}
                  onChange={(e) =>
                    setFindings((xs) =>
                      xs.map((x, i) => (i === index ? { ...x, kind: e.target.value } : x)),
                    )
                  }
                >
                  <option value="CAPABILITY_EVIDENCE">Capability evidence</option>
                  <option value="ASSESSMENT_EVIDENCE">Assessment evidence</option>
                  <option value="OWNERSHIP_EVIDENCE">Ownership evidence</option>
                </select>
                <label htmlFor={'assessment-detail-' + index}>Finding {index + 1}</label>
                <textarea
                  id={'assessment-detail-' + index}
                  required
                  maxLength={2000}
                  rows={3}
                  value={f.detail}
                  onChange={(e) =>
                    setFindings((xs) =>
                      xs.map((x, i) => (i === index ? { ...x, detail: e.target.value } : x)),
                    )
                  }
                />
                {findings.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setFindings((xs) => xs.filter((_, i) => i !== index))}
                  >
                    Remove finding {index + 1}
                  </button>
                )}
              </div>
            ))}
            {action !== 'REVOKE' && (
              <>
                <label htmlFor="assessment-due">Reassessment due date (UTC)</label>
                <input
                  id="assessment-due"
                  type="text"
                  required
                  placeholder="2026-12-01T00:00:00.000Z"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              </>
            )}
            <div className="orientation-actions">
              <button
                type="button"
                className="button secondary"
                disabled={findings.length >= 20}
                onClick={() =>
                  setFindings((xs) => [...xs, { kind: 'CAPABILITY_EVIDENCE', detail: '' }])
                }
              >
                Add finding
              </button>
              <button type="submit" className="button">
                Save state decision
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <p>
        Commands use the source and policy versions observed on this page. Keep it open during an
        uncertain save and retry the same request.
      </p>
      <button
        type="button"
        className="button secondary"
        onClick={recheck}
        disabled={!ready || pending}
      >
        Recheck current case
      </button>
      <PracticeReviewCase review={r} actionsAvailable />
    </div>
  );
}
