import { RecordPracticeTrialOwnershipInputSchema } from './practice-trial-ownership-contracts';
import { parseOwnershipWriteResult } from './practice-ownership-results';
import type { PracticeOwnershipContext } from './practice-ownership-context';
export type OwnershipInput = ReturnType<typeof RecordPracticeTrialOwnershipInputSchema.parse>;
export type OwnershipWrite = (
  input: OwnershipInput,
  key: string,
) => Promise<{ status: number; body: unknown }>;
export type OwnershipEditorState = Readonly<{
  phase: 'EDITING' | 'READ_ONLY' | 'BUSY' | 'UNCERTAIN' | 'SAVED' | 'STALE' | 'BLOCKED' | 'DENIED';
  context: PracticeOwnershipContext | null;
  message: string;
}>;
export function ownershipEndpoint(assignmentId: string, submissionId: string) {
  return (
    '/api/v1/practice/reviews/' +
    encodeURIComponent(assignmentId) +
    '/submissions/' +
    encodeURIComponent(submissionId) +
    '/ownership'
  );
}
export const writeOwnership: OwnershipWrite = async (input, key) => {
  const response = await fetch(ownershipEndpoint(input.assignmentId, input.submissionId), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
/** Pending private body/key live only in this mounted controller, never browser storage. */
export function createOwnershipEditor(
  context: PracticeOwnershipContext,
  write: OwnershipWrite = writeOwnership,
  key: () => string = () => crypto.randomUUID(),
) {
  let state: OwnershipEditorState = {
    phase: context.writesAvailable && context.policy ? 'EDITING' : 'READ_ONLY',
    context,
    message: '',
  };
  let pending: { input: OwnershipInput; key: string } | null = null;
  const listeners = new Set<() => void>();
  const change = (next: OwnershipEditorState) => {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };
  async function send() {
    if (!pending) return;
    const command = pending;
    change({ ...state, phase: 'BUSY', message: 'Saving finding…' });
    try {
      const response = await write(command.input, command.key);
      if (response.status === 200) {
        const result = parseOwnershipWriteResult(
          response.body,
          command.input,
          context.review.assignment.evaluatorAccountId,
        );
        pending = null;
        change({
          ...state,
          phase: 'SAVED',
          context: result.view ? { ...context, ownership: result.view } : null,
          message: result.view
            ? 'Finding saved. Recheck the current case before another decision.'
            : 'Finding saved. Private details are currently unavailable. Recheck access later.',
        });
        return;
      }
      if ([401, 403, 404].includes(response.status)) {
        pending = null;
        change({
          phase: 'DENIED',
          context: null,
          message: 'Access to this case is unavailable. Sign in or recheck your assignment.',
        });
        return;
      }
      const code = (response.body as { error?: { code?: unknown } } | null)?.error?.code;
      if (response.status === 409 && code === 'REVISION_CHANGED') {
        pending = null;
        change({
          ...state,
          phase: 'STALE',
          message:
            'The policy or finding changed. Recheck and review the current case before saving.',
        });
        return;
      }
      if (response.status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') {
        change({
          ...state,
          phase: 'BLOCKED',
          message:
            'This request key belongs to a different command. Recover the original request before continuing.',
        });
        return;
      }
      if ([413, 415, 422].includes(response.status) && code === 'INVALID_COMMAND') {
        pending = null;
        change({
          ...state,
          phase: 'EDITING',
          message:
            'The finding was rejected. Check the reason and observations before trying again.',
        });
        return;
      }
    } catch {
      /* Never display unknown private diagnostics. */
    }
    change({
      ...state,
      phase: 'UNCERTAIN',
      message:
        'Save status is uncertain. Keep this page open and retry the same request before making another decision.',
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
    async save(fields: unknown) {
      if (state.phase !== 'EDITING' || !context.policy) return;
      const parsed = RecordPracticeTrialOwnershipInputSchema.safeParse({
        version: 'v1',
        assignmentId: context.review.assignment.id,
        submissionId: context.review.submission.reference.recordId,
        expectedSubmissionReference: context.review.submission.reference,
        expectedDefinitionReference: context.review.definition.reference,
        expectedRubricReference: context.review.definition.rubric.reference,
        expectedPolicyReference: context.policy.policy.reference,
        expectedOwnershipReference: context.ownership?.record.reference ?? null,
        ...(fields as object),
      });
      if (!parsed.success) {
        change({
          ...state,
          message:
            'Choose a finding and add a reason and at least one observation (up to 2,000 characters each).',
        });
        return;
      }
      // Fields may contain only editable values; no forged source/context keys.
      if (
        !fields ||
        typeof fields !== 'object' ||
        Object.keys(fields).some((k) => !['decision', 'reason', 'observations'].includes(k))
      ) {
        change({ ...state, message: 'Invalid finding fields.' });
        return;
      }
      try {
        pending = { input: parsed.data, key: key() };
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
