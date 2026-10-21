import {
  RecordPracticeTrialAssessmentInputSchema,
  RecordPracticeAssessmentDecisionInputSchema,
} from './practice-trial-assessment-contracts';
import {
  parsePracticeAssessmentReviewWriteResult,
  parsePracticeAssessmentDecisionWriteResult,
} from './practice-assessment-results';
import type { PracticeAssessmentContext } from './practice-assessment-context';
export type AssessmentReviewInput = ReturnType<
  typeof RecordPracticeTrialAssessmentInputSchema.parse
>;
export type AssessmentDecisionInput = ReturnType<
  typeof RecordPracticeAssessmentDecisionInputSchema.parse
>;
export type AssessmentWrite = (
  kind: 'review' | 'decisions',
  input: AssessmentReviewInput | AssessmentDecisionInput,
  key: string,
) => Promise<{ status: number; body: unknown }>;
export type AssessmentSaved =
  | { kind: 'review'; view: ReturnType<typeof parsePracticeAssessmentReviewWriteResult>['view'] }
  | {
      kind: 'decisions';
      view: ReturnType<typeof parsePracticeAssessmentDecisionWriteResult>['view'];
    };
export type AssessmentEditorState = Readonly<{
  phase: 'EDITING' | 'READ_ONLY' | 'BUSY' | 'UNCERTAIN' | 'SAVED' | 'STALE' | 'BLOCKED' | 'DENIED';
  context: PracticeAssessmentContext | null;
  message: string;
  saved: AssessmentSaved | null;
}>;
export const writeAssessment: AssessmentWrite = async (kind, input, key) => {
  const endpoint =
    '/api/v1/practice/reviews/' +
    encodeURIComponent(input.assignmentId) +
    '/submissions/' +
    encodeURIComponent(input.submissionId) +
    '/assessment' +
    (kind === 'decisions' ? '/decisions' : '');
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
export const canReviewAssessment = (c: PracticeAssessmentContext) =>
  Boolean(c.policy && c.reviewWritesAvailable);
export const canDecideAssessment = (c: PracticeAssessmentContext) =>
  Boolean(
    c.policy &&
    c.decisionWritesAvailable &&
    c.assessmentState?.isCurrent &&
    c.assessmentState.assessment.state !== 'REVOKED' &&
    c.references.currentAssessmentReference &&
    c.references.currentReviewReference &&
    c.references.currentOwnershipReference,
  );
const rejected: Record<string, string> = {
  INVALID_COMMAND: 'Check the required reason, criteria, findings and dates.',
  EVIDENCE_NOT_CONFIRMED: 'Current confirmed ownership is required before verification.',
  RUBRIC_NOT_MET: 'Every required original rubric criterion must be met before verification.',
  HIGH_RANK_EVIDENCE_REQUIRED: 'This rank requires additional independent evidence.',
  TOOLS_POLICY_NOT_MET: 'Review the accepted original tools and AI policy before verification.',
};
/** One in-memory pending command shared by both forms; no persistence or automatic reload retry. */
export function createAssessmentEditor(
  context: PracticeAssessmentContext,
  write: AssessmentWrite = writeAssessment,
  key: () => string = () => crypto.randomUUID(),
) {
  let state: AssessmentEditorState = {
    phase: canReviewAssessment(context) || canDecideAssessment(context) ? 'EDITING' : 'READ_ONLY',
    context,
    message: '',
    saved: null,
  };
  let pending:
    | ((
        | { kind: 'review'; input: AssessmentReviewInput }
        | { kind: 'decisions'; input: AssessmentDecisionInput }
      ) & { key: string })
    | null = null;
  const listeners = new Set<() => void>();
  const change = (next: AssessmentEditorState) => {
    state = Object.freeze(next);
    listeners.forEach((f) => f());
  };
  async function send() {
    if (!pending) return;
    const command = pending;
    change({ ...state, phase: 'BUSY', message: 'Saving assessment…' });
    try {
      const response = await write(command.kind, command.input, command.key);
      if (response.status === 200) {
        let saved: AssessmentSaved;
        if (command.kind === 'review')
          saved = {
            kind: 'review',
            view: parsePracticeAssessmentReviewWriteResult(
              response.body,
              command.input,
              context.review.assignment.evaluatorAccountId,
            ).view,
          };
        else
          saved = {
            kind: 'decisions',
            view: parsePracticeAssessmentDecisionWriteResult(
              response.body,
              command.input,
              context.review.assignment.evaluatorAccountId,
            ).view,
          };
        pending = null;
        change({
          ...state,
          phase: 'SAVED',
          saved,
          context: saved.view ? context : null,
          message: saved.view
            ? 'Assessment saved. Recheck the current case before another action.'
            : 'Assessment saved. Private details are currently unavailable. Recheck access later.',
        });
        return;
      }
      if ([401, 403, 404].includes(response.status)) {
        pending = null;
        change({
          phase: 'DENIED',
          context: null,
          saved: null,
          message: 'Access to this case is unavailable. Sign in or recheck your assignment.',
        });
        return;
      }
      const code = (response.body as { error?: { code?: unknown } } | null)?.error?.code;
      if (
        response.status === 409 &&
        ['REVISION_CHANGED', 'FAMILY_CHANGED', 'CURRENT_HIGHER_ASSESSMENT'].includes(String(code))
      ) {
        pending = null;
        change({
          ...state,
          phase: 'STALE',
          message:
            code === 'CURRENT_HIGHER_ASSESSMENT'
              ? 'A higher assessment already exists. Recheck before a reasoned reassessment.'
              : 'The case, policy or assessment changed. Recheck and review current evidence before saving.',
        });
        return;
      }
      if (response.status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') {
        change({
          ...state,
          phase: 'BLOCKED',
          message:
            'This key belongs to another command. Recover the original request before continuing.',
        });
        return;
      }
      if (
        [413, 415, 422].includes(response.status) &&
        typeof code === 'string' &&
        Object.hasOwn(rejected, code)
      ) {
        pending = null;
        change({ ...state, phase: 'EDITING', message: rejected[code] });
        return;
      }
    } catch {
      /* Private diagnostics stay private; an unvalidated success may already be committed. */
    }
    change({
      ...state,
      phase: 'UNCERTAIN',
      message:
        'Save status is uncertain. Keep this page open and retry the same request before making another assessment action.',
    });
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async save(kind: 'review' | 'decisions', fields: unknown) {
      if (
        state.phase !== 'EDITING' ||
        !context.policy ||
        (kind === 'review' ? !canReviewAssessment(context) : !canDecideAssessment(context))
      )
        return;
      const allowed =
        kind === 'review'
          ? ['decision', 'reason', 'confidenceStatement', 'criteria', 'reassessmentAt']
          : ['action', 'reasonCategory', 'reason', 'findings', 'dueAt'];
      if (
        !fields ||
        typeof fields !== 'object' ||
        Array.isArray(fields) ||
        Object.keys(fields).some((k) => !allowed.includes(k))
      ) {
        change({ ...state, message: 'Invalid assessment fields.' });
        return;
      }
      const c = context,
        r = c.references;
      const common = {
        ...fields,
        version: 'v1',
        assignmentId: c.review.assignment.id,
        submissionId: c.review.submission.reference.recordId,
        expectedPolicyReference: c.policy!.policy.reference,
        expectedOwnershipReference: r.currentOwnershipReference,
        expectedReviewReference: r.currentReviewReference,
        expectedAssessmentReference: r.currentAssessmentReference,
      };
      try {
        if (kind === 'review') {
          const input = RecordPracticeTrialAssessmentInputSchema.safeParse({
            ...common,
            expectedSubmissionReference: c.review.submission.reference,
            expectedDefinitionReference: c.review.definition.reference,
            expectedRubricReference: c.review.definition.rubric.reference,
          });
          if (!input.success) {
            change({
              ...state,
              message:
                'Complete the reason, confidence and every original criterion (up to 2,000 characters each). Use a valid UTC date.',
            });
            return;
          }
          pending = { kind, input: input.data, key: key() };
        } else {
          const input = RecordPracticeAssessmentDecisionInputSchema.safeParse(common);
          if (!input.success) {
            change({
              ...state,
              message:
                'Choose an action, specific evidence and a reason. Capability recheck requires a future UTC due date.',
            });
            return;
          }
          pending = { kind, input: input.data, key: key() };
        }
      } catch {
        change({ ...state, message: 'Could not create a request. Try again.' });
        return;
      }
      await send();
    },
    async retry() {
      if (state.phase === 'UNCERTAIN') await send();
    },
  };
}
