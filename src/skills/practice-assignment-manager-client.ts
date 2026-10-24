import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import {
  IssuePracticeReviewAssignmentInputSchema,
  RevokePracticeReviewAssignmentInputSchema,
  PracticeReviewAssignmentIssueResultSchema,
  PracticeReviewAssignmentRevokeResultSchema,
} from './practice-review-assignment-contracts';
import {
  PracticeAssignmentManagementInputSchema,
  PracticeAssignmentManagementResultSchema,
  type PracticeAssignmentManagementContext,
  type PracticeAssignmentManagementInput,
} from './practice-review-assignment-management-contracts';
export type AssignmentOperation = 'ISSUE' | 'REVOKE';
export type AssignmentManagerTransport = {
  write: (
    kind: AssignmentOperation,
    input: unknown,
    key: string,
  ) => Promise<{ status: number; body: unknown }>;
  read: (input: PracticeAssignmentManagementInput) => Promise<{ status: number; body: unknown }>;
};
export type AssignmentManagerState = Readonly<{
  phase:
    | 'EDITING'
    | 'READ_ONLY'
    | 'BUSY'
    | 'UNCERTAIN'
    | 'BLOCKED'
    | 'SAVED'
    | 'STALE'
    | 'DENIED'
    | 'LOADING'
    | 'UNAVAILABLE';
  context: PracticeAssignmentManagementContext | null;
  message: string;
  outcome: { kind: AssignmentOperation; body: unknown } | null;
}>;
export function assignmentManagementEndpoint(input: PracticeAssignmentManagementInput) {
  const query = new URLSearchParams();
  if (input.submissionId) query.set('submissionId', input.submissionId);
  if (input.after) query.set('after', input.after);
  return '/api/v1/admin/practice/review-assignments' + (query.size ? '?' + query : '');
}
export const assignmentManagerTransport: AssignmentManagerTransport = {
  async write(kind, input, key) {
    const path =
      '/api/v1/admin/practice/review-assignments' +
      (kind === 'REVOKE'
        ? '/' +
          encodeURIComponent((input as { assignmentId: string }).assignmentId) +
          '/revocations'
        : '');
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  },
  async read(input) {
    const response = await fetch(assignmentManagementEndpoint(input), {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  },
};
type Pending =
  | { kind: 'ISSUE'; input: z.output<typeof IssuePracticeReviewAssignmentInputSchema>; key: string }
  | {
      kind: 'REVOKE';
      input: z.output<typeof RevokePracticeReviewAssignmentInputSchema>;
      key: string;
    };
/** One in-memory immutable command across both forms. No browser persistence or automatic recovery. */
export function createPracticeAssignmentManager(
  initial: PracticeAssignmentManagementContext,
  transport: AssignmentManagerTransport = assignmentManagerTransport,
  key: () => string = () => crypto.randomUUID(),
) {
  const initialContext = PracticeAssignmentManagementResultSchema.parse(initial),
    actorAccountId = initialContext.page.actorAccountId;
  let state: AssignmentManagerState = {
    phase: initialContext.writesAvailable ? 'EDITING' : 'READ_ONLY',
    context: initialContext,
    message: '',
    outcome: null,
  };
  let pending: Pending | null = null;
  const listeners = new Set<() => void>();
  const change = (next: AssignmentManagerState) => {
    state = Object.freeze(next);
    listeners.forEach((fn) => fn());
  };
  async function send() {
    if (!pending) return;
    const command = pending;
    change({ ...state, phase: 'BUSY', message: 'Saving appointment…' });
    try {
      const response = await transport.write(command.kind, command.input, command.key);
      if (response.status === 200) {
        let body: unknown;
        if (command.kind === 'ISSUE') {
          const result = PracticeReviewAssignmentIssueResultSchema.parse(response.body),
            a = result.assignment,
            i = command.input;
          if (
            a.submissionId !== i.submissionId ||
            a.evaluatorAccountId !== i.evaluatorAccountId ||
            a.purpose !== i.purpose ||
            a.expiresAt !== i.expiresAt ||
            a.reason !== i.reason ||
            a.issuedByAccountId !== actorAccountId
          )
            throw new Error('UNBOUND_RESULT');
          body = result;
        } else {
          const result = PracticeReviewAssignmentRevokeResultSchema.parse(response.body),
            r = result.revocation;
          if (
            r.assignmentId !== command.input.assignmentId ||
            r.reason !== command.input.reason ||
            r.revokedByAccountId !== actorAccountId
          )
            throw new Error('UNBOUND_RESULT');
          body = result;
        }
        pending = null;
        change({
          ...state,
          phase: 'SAVED',
          outcome: { kind: command.kind, body },
          message:
            'Saved original receipt (historical result). Refresh current appointments before another action.',
        });
        return;
      }
      if ([401, 403].includes(response.status)) {
        // Both causes fail closed. A 403 envelope cannot tell a lost session from a business denial
        // (e.g. self-review or out-of-scope appointee): the code is FORBIDDEN for both, so say neither.
        pending = null;
        change({
          phase: 'DENIED',
          context: null,
          outcome: null,
          message:
            response.status === 403
              ? 'This action was not permitted for the current account or the selected appointee. Private details were cleared; recheck management access and try again.'
              : 'Management access is unavailable. Sign in with an authorized administrator account and recheck.',
        });
        return;
      }
      const code = (response.body as { error?: { code?: unknown } } | null)?.error?.code;
      if (response.status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') {
        change({
          ...state,
          phase: 'BLOCKED',
          message:
            'This request key belongs to another command. Discard the request and recheck current appointments before continuing.',
        });
        return;
      }
      if (response.status === 404 || (response.status === 409 && code === 'REVISION_CHANGED')) {
        const missingIssueTarget = response.status === 404 && command.kind === 'ISSUE';
        pending = null;
        change({
          ...state,
          phase: 'STALE',
          message: missingIssueTarget
            ? 'The submission or evaluator was not found. Refresh current appointments before another action.'
            : 'This appointment changed or was already revoked. Refresh current appointments before another action.',
        });
        return;
      }
      if ([413, 415, 422].includes(response.status) && code === 'INVALID_COMMAND') {
        pending = null;
        change({
          ...state,
          phase: 'EDITING',
          message:
            'The request was rejected. Check its identifiers, expiry and reason before trying again.',
        });
        return;
      }
    } catch {
      /* Unknown outcome never exposes diagnostics or loses pending identity. */
    }
    change({
      ...state,
      phase: 'UNCERTAIN',
      message:
        'Save status is uncertain. Keep this page open and retry the same request before another action. If retrying keeps failing, discard the request and recheck current appointments: the earlier save may or may not have applied.',
    });
  }
  const begin = async (command: Omit<Pending, 'key'>) => {
    let identity: string;
    try {
      identity = InternalId.parse(key());
    } catch {
      change({ ...state, message: 'Could not create a request. Try again.' });
      return;
    }
    pending = Object.freeze({ ...command, key: identity }) as Pending;
    await send();
  };
  const api = {
    snapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async issue(fields: unknown) {
      if (state.phase !== 'EDITING' || !state.context?.writesAvailable) return;
      if (
        !fields ||
        typeof fields !== 'object' ||
        Array.isArray(fields) ||
        Object.keys(fields).some(
          (k) =>
            !['submissionId', 'evaluatorAccountId', 'purpose', 'expiresAt', 'reason'].includes(k),
        )
      ) {
        change({ ...state, message: 'Invalid appointment fields.' });
        return;
      }
      const editable = IssuePracticeReviewAssignmentInputSchema.safeParse({
        version: 'v1',
        ...fields,
      });
      if (!editable.success) {
        change({
          ...state,
          message:
            'Enter a submission, evaluator, purpose, finite UTC expiry and reason (up to 2,000 characters).',
        });
        return;
      }
      const values = editable.data,
        input = IssuePracticeReviewAssignmentInputSchema.parse({
          ...values,
          submissionId: values.submissionId.toLowerCase(),
          expiresAt: new Date(values.expiresAt).toISOString(),
        });
      if (
        state.context.page.submissionId !== null &&
        input.submissionId !== state.context.page.submissionId
      ) {
        change({
          ...state,
          message:
            'Use the submission currently being managed, or look up another submission first.',
        });
        return;
      }
      await begin({ kind: 'ISSUE', input });
    },
    async revoke(assignmentId: string, reason: string) {
      if (state.phase !== 'EDITING' || !state.context?.writesAvailable) return;
      const entry = state.context.page.entries.find(
        (e) => e.assignment.id === assignmentId && e.currentState !== 'REVOKED',
      );
      const input = RevokePracticeReviewAssignmentInputSchema.safeParse({
        version: 'v1',
        assignmentId,
        reason,
      });
      if (!entry || !input.success) {
        change({
          ...state,
          message: 'Choose an observed appointment that has not been revoked and provide a reason.',
        });
        return;
      }
      await begin({ kind: 'REVOKE', input: input.data });
    },
    async retry() {
      if (state.phase === 'UNCERTAIN') await send();
    },
    /** Explicitly abandon an unresolved command (its outcome stays unknown), then reload current appointments. */
    async discard() {
      if (state.phase !== 'UNCERTAIN' && state.phase !== 'BLOCKED') return;
      pending = null;
      await api.refresh();
    },
    /** Reload the submission currently displayed, never editable lookup text. */
    refresh() {
      return api.load({
        version: 'v1',
        submissionId: state.context?.page.submissionId ?? null,
        after: null,
      });
    },
    async load(value: unknown) {
      if (pending || state.phase === 'LOADING') return;
      const input = PracticeAssignmentManagementInputSchema.safeParse(value);
      if (!input.success) {
        change({ ...state, message: 'Enter a valid submission identifier.' });
        return;
      }
      change({
        ...state,
        phase: 'LOADING',
        message: 'Checking current appointments…',
        outcome: null,
      });
      try {
        const response = await transport.read(input.data);
        if ([401, 403, 404].includes(response.status)) {
          change({
            phase: 'DENIED',
            context: null,
            message:
              'Management access is unavailable. Sign in with an authorized administrator account and recheck.',
            outcome: null,
          });
          return;
        }
        const parsed =
          response.status === 200
            ? PracticeAssignmentManagementResultSchema.safeParse(response.body)
            : null;
        if (
          !parsed?.success ||
          parsed.data.page.actorAccountId !== actorAccountId ||
          parsed.data.page.submissionId !== input.data.submissionId ||
          parsed.data.page.after !== input.data.after
        )
          throw new Error('UNBOUND_READ');
        change({
          phase: parsed.data.writesAvailable ? 'EDITING' : 'READ_ONLY',
          context: parsed.data,
          message: '',
          outcome: null,
        });
        return;
      } catch {
        /* Clear old metadata on failed fresh reads; no stale list can become authority. */
      }
      change({
        phase: 'UNAVAILABLE',
        context: null,
        message: 'Current appointments are unavailable. Try rechecking later.',
        outcome: null,
      });
    },
  };
  return api;
}
