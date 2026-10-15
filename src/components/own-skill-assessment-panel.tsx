'use client';
import { useEffect, useId, useRef, useState } from 'react';
import {
  OwnSkillAssessmentHttpStateSchema,
  type OwnSkillAssessmentHttpState,
  type OwnSkillAssessmentView,
} from '../skills/own-assessment-contracts';
export interface OwnSkillAssessmentPanelProps {
  initialState: OwnSkillAssessmentHttpState;
  skillId: string;
  skillDomain: string;
  taxonomyId: string;
}
function checked(
  value: unknown,
  skillId: string,
  skillDomain: string,
  taxonomyId: string,
): OwnSkillAssessmentView | null {
  const p = OwnSkillAssessmentHttpStateSchema.safeParse(value);
  return p.success &&
    p.data.readsAvailable &&
    p.data.view?.skillId === skillId &&
    p.data.view.skillDomain === skillDomain &&
    p.data.view.taxonomyReference.recordId === taxonomyId
    ? p.data.view
    : null;
}
function date(value: string) {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value)) + ' UTC'
  );
}
const labels = {
  NO_ASSESSMENT: 'Not yet assessed',
  VERIFIED: 'Verified',
  REASSESSMENT_REQUIRED: 'Reassessment required',
  REVOKED: 'Verification revoked',
} as const;
/** A bounded private summary from the current server source; refresh failures remove old details. */
export function OwnSkillAssessmentPanel(props: OwnSkillAssessmentPanelProps) {
  const source = OwnSkillAssessmentHttpStateSchema.safeParse(props.initialState);
  const identity = JSON.stringify([
    props.skillId,
    props.skillDomain,
    props.taxonomyId,
    source.success ? source.data : null,
  ]);
  return <OwnSkillAssessmentPanelState key={identity} {...props} />;
}
function OwnSkillAssessmentPanelState({
  initialState,
  skillId,
  skillDomain,
  taxonomyId,
}: OwnSkillAssessmentPanelProps) {
  const title = useId(),
    controller = useRef<AbortController | null>(null),
    [view, setView] = useState(() => checked(initialState, skillId, skillDomain, taxonomyId)),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  useEffect(() => () => controller.current?.abort(), []);
  async function refresh() {
    if (busy) return;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/v1/skill-assessments/' + encodeURIComponent(skillId), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: active.signal,
      });
      if (active.signal.aborted) return;
      if (!response.ok) {
        setView(null);
        setMessage(
          response.status === 401
            ? 'Sign in to view this assessment.'
            : response.status === 403
              ? 'This assessment is unavailable for your account.'
              : response.status === 429
                ? 'Too many requests. Wait a moment and try again.'
                : 'Assessment is unavailable. Try again later.',
        );
        return;
      }
      const current = checked(await response.json(), skillId, skillDomain, taxonomyId);
      if (active.signal.aborted) return;
      if (!current) {
        setView(null);
        setMessage('Assessment is unavailable. Try again later.');
        return;
      }
      setView(current);
    } catch {
      if (!active.signal.aborted) {
        setView(null);
        setMessage('Assessment is unavailable. Try again later.');
      }
    } finally {
      if (!active.signal.aborted) {
        setBusy(false);
        controller.current = null;
      }
    }
  }
  return (
    <section className="orientation-card" aria-labelledby={title} aria-busy={busy}>
      <h2 id={title}>Assessment</h2>
      {busy ? (
        <p role="status">Loading assessment…</p>
      ) : message ? (
        <p role="alert">{message}</p>
      ) : view ? (
        <>
          <p role="status">{labels[view.effectiveStatus]}</p>
          {view.assessedRank && (
            <p>
              {view.effectiveStatus === 'VERIFIED' ? 'Assessed rank: ' : 'Last assessed rank: '}
              {view.assessedRank}
            </p>
          )}
          {view.effectiveStatus === 'NO_ASSESSMENT' && (
            <p>No assessment has been recorded for this skill.</p>
          )}
          {view.reasonCategory === 'CAPABILITY_RECHECK' && <p>A capability recheck is required.</p>}
          {view.reasonCategory === 'FRAUDULENT_ASSESSMENT_EVIDENCE' && (
            <p>This verification was revoked following an assessment evidence review.</p>
          )}
          {view.recordedState === 'VERIFIED' &&
            view.effectiveStatus === 'REASSESSMENT_REQUIRED' && (
              <p>Scheduled reassessment is due.</p>
            )}
          {view.issuedAt && (
            <p>
              Recorded: <time dateTime={view.issuedAt}>{date(view.issuedAt)}</time>
            </p>
          )}
          {view.reassessmentAt && (
            <p>
              Reassessment date:{' '}
              <time dateTime={view.reassessmentAt}>{date(view.reassessmentAt)}</time>
            </p>
          )}
          <p>
            Checked: <time dateTime={view.observedAt}>{date(view.observedAt)}</time>
          </p>
        </>
      ) : (
        <p role="status">Assessment is unavailable. Try again later.</p>
      )}
      <button className="button secondary" type="button" disabled={busy} onClick={refresh}>
        Refresh assessment
      </button>
    </section>
  );
}
