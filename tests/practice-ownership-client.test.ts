import { expect, it, vi } from 'vitest';
import { reviewViewFixture as review } from './helpers/practice-review-view-fixture';
import { createOwnershipEditor } from '../src/skills/practice-ownership-client';
const ref = review.definition.reference;
const context = {
  version: 'v1' as const,
  review,
  policy: {
    version: 'v1',
    private: true,
    accessId: crypto.randomUUID(),
    isAuthorizationToken: false,
    policy: { reference: ref, guidance: '<script>private-policy</script>' },
  },
  ownership: null,
  writesAvailable: true,
};
const fields = {
  decision: 'CONFIRM',
  reason: ' private-reason ',
  observations: [{ kind: 'EXPLANATION', detail: ' private-observation ' }],
};
function setup(reply?: unknown) {
  const write = vi.fn().mockResolvedValue(reply ?? { status: 503, body: {} });
  const key = vi.fn(() => 'stable-key');
  const editor = createOwnershipEditor(context as never, write, key);
  return { editor, write, key };
}
function success(
  input: import('../src/skills/practice-ownership-client').OwnershipInput,
  overrides: Record<string, unknown> = {},
) {
  const record = {
    version: 'v1',
    id: crypto.randomUUID(),
    reference: {
      recordId: input.submissionId,
      revision: (input.expectedOwnershipReference?.revision ?? 0) + 1,
    },
    submissionReference: input.expectedSubmissionReference,
    participantId: review.submission.participantId,
    definitionReference: input.expectedDefinitionReference,
    rubricReference: input.expectedRubricReference,
    skillId: review.submission.skillId,
    skillDomain: review.submission.skillDomain,
    assignmentId: input.assignmentId,
    policyVersionId: crypto.randomUUID(),
    policyReference: input.expectedPolicyReference,
    evaluatorAccountId: review.assignment.evaluatorAccountId,
    decision: input.decision,
    ownership:
      input.decision === 'CONFIRM'
        ? 'CONFIRMED'
        : input.decision === 'DISPUTE'
          ? 'DISPUTED'
          : 'UNCONFIRMED',
    reason: input.reason,
    observations: input.observations,
    caseAccessId: crypto.randomUUID(),
    policyAccessId: crypto.randomUUID(),
    reviewedAt: '2026-10-21T00:00:00.000Z',
    persisted: true,
    verifiesSkill: false,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  };
  return {
    version: 'v1',
    status: 'EXECUTED',
    view: {
      version: 'v1',
      private: true,
      record,
      currentReference: record.reference,
      isCurrent: true,
      accessId: crypto.randomUUID(),
      isAuthorizationToken: false,
    },
    readsAvailable: true,
    writesAvailable: true,
    unavailableReason: null,
    ...overrides,
  };
}
it('builds exact canonical source/body with actual context and one stable key', async () => {
  const { editor, write, key } = setup();
  await editor.save(fields);
  const [input, k] = write.mock.calls[0];
  expect(k).toBe('stable-key');
  expect(key).toHaveBeenCalledTimes(1);
  expect(input).toEqual({
    version: 'v1',
    assignmentId: review.assignment.id,
    submissionId: review.submission.reference.recordId,
    expectedSubmissionReference: review.submission.reference,
    expectedDefinitionReference: ref,
    expectedRubricReference: review.definition.rubric.reference,
    expectedPolicyReference: ref,
    expectedOwnershipReference: null,
    decision: 'CONFIRM',
    reason: 'private-reason',
    observations: [{ kind: 'EXPLANATION', detail: 'private-observation' }],
  });
  expect(editor.snapshot().phase).toBe('UNCERTAIN');
});
it.each([
  { ...fields, reason: ' ' },
  { ...fields, observations: [] },
  { ...fields, decision: 'GUILTY' },
  { ...fields, reason: '\ud800' },
])('rejects invalid fields before key or transport %#', async (bad) => {
  const { editor, write, key } = setup();
  await editor.save(bad);
  expect(write).not.toHaveBeenCalled();
  expect(key).not.toHaveBeenCalled();
  expect(editor.snapshot().phase).toBe('EDITING');
});
it.each([
  { ...context, writesAvailable: false },
  { ...context, policy: null },
])('prevents new save without configured writes and canonical approved policy %#', async (ctx) => {
  const write = vi.fn();
  const editor = createOwnershipEditor(ctx as never, write, () => 'k');
  await editor.save(fields);
  expect(write).not.toHaveBeenCalled();
  expect(editor.snapshot().phase).toBe('READ_ONLY');
});
it('retains identical immutable body/key across unknown outcome, blocking new commands', async () => {
  const { editor, write, key } = setup();
  await editor.save(fields);
  const [first, k] = write.mock.calls[0];
  await editor.save({ ...fields, reason: 'different' });
  expect(write).toHaveBeenCalledTimes(1);
  write.mockResolvedValue({
    status: 200,
    body: success(first, {
      status: 'REPLAYED',
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    }),
  });
  await editor.retry();
  expect(write.mock.calls[1]).toEqual([first, k]);
  expect(key).toHaveBeenCalledTimes(1);
  expect(editor.snapshot().phase).toBe('SAVED');
});
it('blocks duplicate clicks while actual save is in flight', async () => {
  let finish!: (value: { status: number; body: unknown }) => void;
  const { editor, write } = setup();
  write.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  const pending = editor.save(fields);
  expect(editor.snapshot().phase).toBe('BUSY');
  await editor.save(fields);
  await editor.retry();
  expect(write).toHaveBeenCalledTimes(1);
  finish({ status: 503, body: {} });
  await pending;
});
it.each([401, 403, 404])('hides context after authority loss %s', async (status) => {
  const { editor } = setup({ status, body: {} });
  await editor.save(fields);
  expect(editor.snapshot()).toMatchObject({ phase: 'DENIED', context: null });
});
it('requires recheck after stale current reference', async () => {
  const { editor, write } = setup({ status: 409, body: { error: { code: 'REVISION_CHANGED' } } });
  await editor.save(fields);
  expect(editor.snapshot().phase).toBe('STALE');
  await editor.save(fields);
  await editor.retry();
  expect(write).toHaveBeenCalledTimes(1);
});
it('blocks changed-key collision without claiming save or generating a replacement key', async () => {
  const { editor, write, key } = setup({
    status: 409,
    body: { error: { code: 'IDEMPOTENCY_KEY_REUSED' } },
  });
  await editor.save(fields);
  expect(editor.snapshot().phase).toBe('BLOCKED');
  await editor.retry();
  expect(write).toHaveBeenCalledTimes(1);
  expect(key).toHaveBeenCalledTimes(1);
});
it.each([429, 503])('keeps retry identity for transport status %s', async (status) => {
  const { editor, write } = setup({ status, body: {} });
  await editor.save(fields);
  await editor.retry();
  expect(write.mock.calls[1]).toEqual(write.mock.calls[0]);
  expect(editor.snapshot().phase).toBe('UNCERTAIN');
});
it('contains network exceptions and malformed success without losing pending command', async () => {
  const { editor, write } = setup();
  write.mockRejectedValue(new Error('private-diagnostic'));
  await editor.save(fields);
  expect(editor.snapshot().phase).toBe('UNCERTAIN');
  write.mockResolvedValue({ status: 200, body: { secret: 'private-diagnostic' } });
  await editor.retry();
  expect(editor.snapshot().phase).toBe('UNCERTAIN');
  expect(JSON.stringify(editor.snapshot().message)).not.toContain('private-diagnostic');
});
it('accepts committed success with read gate closed without inventing an unsaved failure', async () => {
  const { editor, write } = setup();
  write.mockImplementation(async (input) => ({
    status: 200,
    body: success(input, {
      view: null,
      readsAvailable: false,
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    }),
  }));
  await editor.save(fields);
  expect(editor.snapshot()).toMatchObject({ phase: 'SAVED', context: null });
});
it('validates result target and author before displaying saved private finding', async () => {
  const { editor, write } = setup();
  write.mockImplementation(async (input) => {
    const body = success(input);
    body.view.record.evaluatorAccountId = 'foreign';
    return { status: 200, body };
  });
  await editor.save(fields);
  expect(editor.snapshot().phase).toBe('UNCERTAIN');
});
it('allows editing again only after definite invalid input rejection', async () => {
  const { editor, write, key } = setup({
    status: 422,
    body: { error: { code: 'INVALID_COMMAND' } },
  });
  await editor.save(fields);
  expect(editor.snapshot().phase).toBe('EDITING');
  await editor.save({ ...fields, reason: 'fixed' });
  expect(write).toHaveBeenCalledTimes(2);
  expect(key).toHaveBeenCalledTimes(2);
});
it('notifies subscribers for actual state transitions', async () => {
  const { editor } = setup();
  const listener = vi.fn();
  const unsubscribe = editor.subscribe(listener);
  await editor.save(fields);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  await editor.retry();
  expect(listener).toHaveBeenCalledTimes(2);
});
it('clears visible context on an HTTP auth denial even when its body is not JSON', async () => {
  const { writeOwnership } = await import('../src/skills/practice-ownership-client');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('upstream error', { status: 401 })),
  );
  try {
    const editor = createOwnershipEditor(context as never, writeOwnership, () => 'stable');
    await editor.save(fields);
    expect(editor.snapshot()).toMatchObject({ phase: 'DENIED', context: null });
  } finally {
    vi.unstubAllGlobals();
  }
});
