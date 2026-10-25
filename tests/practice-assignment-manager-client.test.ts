import { beforeEach, expect, it, vi } from 'vitest';
import {
  createPracticeAssignmentManager,
  type AssignmentManagerTransport,
} from '../src/skills/practice-assignment-manager-client';
import {
  managementContext as context,
  managementIssueFields as fields,
  managementAssignmentId as id,
} from './helpers/practice-assignment-management-view-fixture';
const write = vi.fn(),
  read = vi.fn(),
  key = vi.fn();
const transport: AssignmentManagerTransport = { write, read };
const issueResult = (patch = {}) => ({
  version: 'v1',
  status: 'EXECUTED',
  writesAvailable: true,
  unavailableReason: null,
  assignment: {
    ...context.page.entries[0].assignment,
    purpose: 'ASSESSMENT_REVIEW',
    reason: 'Synthetic finite review.',
  },
  ...patch,
});
const revokeResult = (patch = {}) => ({
  version: 'v1',
  status: 'EXECUTED',
  writesAvailable: true,
  unavailableReason: null,
  revocation: {
    version: 'v1',
    id: '44444444-4444-4444-8444-444444444444',
    assignmentId: id,
    revokedAt: '2026-10-23T12:01:00.000Z',
    revokedByAccountId: 'manager-account',
    reason: 'Synthetic reason.',
    state: 'REVOKED',
    isAuthorizationToken: false,
  },
  ...patch,
});
beforeEach(() => {
  vi.resetAllMocks();
  key.mockReturnValue('stable-key');
  read.mockResolvedValue({ status: 200, body: context });
  write.mockResolvedValue({ status: 200, body: issueResult() });
});
it('builds only canonical issue input from editable fields, saves own-bound receipt, then requires refresh', async () => {
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.issue(fields);
  expect(write).toHaveBeenCalledExactlyOnceWith(
    'ISSUE',
    { version: 'v1', ...fields, reason: 'Synthetic finite review.' },
    'stable-key',
  );
  expect(c.snapshot()).toMatchObject({ phase: 'SAVED', outcome: { kind: 'ISSUE' } });
  await c.issue(fields);
  expect(write).toHaveBeenCalledOnce();
  await c.load({ version: 'v1', submissionId: context.page.submissionId, after: null });
  expect(c.snapshot().phase).toBe('EDITING');
});
it('normalizes pasted UUID case and expiry to exact canonical server result format', async () => {
  const changed = {
    ...fields,
    submissionId: fields.submissionId.toUpperCase(),
    expiresAt: '2030-01-01T00:00:00Z',
  };
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.issue(changed);
  expect(write.mock.calls[0][1]).toMatchObject({
    submissionId: fields.submissionId,
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
  expect(c.snapshot().phase).toBe('SAVED');
});
it.each([
  { ...fields, issuedByAccountId: 'attacker' },
  { ...fields, submissionId: '55555555-5555-4555-8555-555555555555' },
  { ...fields, reason: '' },
  { ...fields, expiresAt: 'bad' },
  { ...fields, version: 'v1' },
])('rejects hidden authority/target/invalid fields %s', async (input) => {
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.issue(input);
  expect(write).not.toHaveBeenCalled();
  expect(c.snapshot().message).not.toBe('');
});
it('builds revoke only for observed nonrevoked assignment with reason and validates own revoker', async () => {
  write.mockResolvedValue({ status: 200, body: revokeResult() });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.revoke(id, '  Synthetic reason.  ');
  expect(write).toHaveBeenCalledExactlyOnceWith(
    'REVOKE',
    { version: 'v1', assignmentId: id, reason: 'Synthetic reason.' },
    'stable-key',
  );
  expect(c.snapshot()).toMatchObject({ phase: 'SAVED', outcome: { kind: 'REVOKE' } });
});
it('does not revoke a guessed unobserved target', async () => {
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.revoke('55555555-5555-4555-8555-555555555555', 'reason');
  expect(write).not.toHaveBeenCalled();
});
it.each(['ISSUE', 'REVOKE'] as const)(
  'keeps exact%s kind/body/key after unknown response and locks all other actions/lookup until same-request replay',
  async (kind) => {
    const result =
      kind === 'ISSUE'
        ? issueResult({ status: 'REPLAYED', writesAvailable: false, unavailableReason: 'DISABLED' })
        : revokeResult({
            status: 'REPLAYED',
            writesAvailable: false,
            unavailableReason: 'DISABLED',
          });
    write
      .mockRejectedValueOnce(new Error('private secret'))
      .mockResolvedValueOnce({ status: 200, body: result });
    const c = createPracticeAssignmentManager(context, transport, key);
    if (kind === 'ISSUE') await c.issue(fields);
    else await c.revoke(id, 'Synthetic reason.');
    expect(c.snapshot().phase).toBe('UNCERTAIN');
    const original = write.mock.calls[0];
    await c.issue({ ...fields, reason: 'Changed' });
    await c.revoke(id, 'Changed');
    await c.load({ version: 'v1', submissionId: null, after: null });
    expect(write).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    await c.retry();
    expect(write.mock.calls[1]).toEqual(original);
    expect(key).toHaveBeenCalledOnce();
    expect(c.snapshot().phase).toBe('SAVED');
    expect(c.snapshot().message).toMatch(/historical|original/i);
  },
);
it('locks duplicate clicks and reads while issue is in flight', async () => {
  let finish!: (r: unknown) => void;
  write.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const c = createPracticeAssignmentManager(context, transport, key);
  const pending = c.issue(fields);
  expect(c.snapshot().phase).toBe('BUSY');
  await c.issue(fields);
  await c.revoke(id, 'reason');
  await c.load({ version: 'v1', submissionId: null, after: null });
  expect(write).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  finish({ status: 200, body: issueResult() });
  await pending;
});
it.each([
  null,
  {},
  issueResult({
    assignment: { ...context.page.entries[0].assignment, issuedByAccountId: 'foreign' },
  }),
  issueResult({
    assignment: {
      ...context.page.entries[0].assignment,
      purpose: 'ASSESSMENT_REVIEW',
      reason: 'different',
    },
  }),
])('keeps malformed/misbound committed success uncertain %s', async (body) => {
  write.mockResolvedValue({ status: 200, body });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.issue(fields);
  expect(c.snapshot().phase).toBe('UNCERTAIN');
  expect(c.snapshot().message).not.toContain('secret');
});
it.each([401, 403])(
  'clears private context for known HTTP%s even malformed error body',
  async (status) => {
    write.mockResolvedValue({ status, body: null });
    const c = createPracticeAssignmentManager(context, transport, key);
    await c.issue(fields);
    expect(c.snapshot()).toMatchObject({ phase: 'DENIED', context: null, outcome: null });
    await c.retry();
    expect(write).toHaveBeenCalledOnce();
  },
);
it.each(['ISSUE', 'REVOKE'] as const)(
  'keeps context and clears pending after a missing %s target, requiring refresh before another command',
  async (kind) => {
    write.mockResolvedValue({ status: 404, body: null });
    const c = createPracticeAssignmentManager(context, transport, key);
    const observed = c.snapshot().context;
    if (kind === 'REVOKE') await c.revoke(id, 'Synthetic reason.');
    else await c.issue(fields);
    expect(c.snapshot()).toMatchObject({ phase: 'STALE', outcome: null });
    expect(c.snapshot().context).toBe(observed);
    expect(c.snapshot().message).toMatch(/refresh current appointments/i);
    if (kind === 'ISSUE') {
      expect(c.snapshot().message).toMatch(/not found/i);
      expect(c.snapshot().message).not.toMatch(/already revoked/i);
    } else expect(c.snapshot().message).toMatch(/already revoked/i);
    await c.retry();
    await c.issue(fields);
    await c.revoke(id, 'Another reason.');
    expect(write).toHaveBeenCalledOnce();
    await c.load({ version: 'v1', submissionId: context.page.submissionId, after: null });
    expect(read).toHaveBeenCalledOnce();
    expect(c.snapshot().phase).toBe('EDITING');
    write.mockResolvedValue({ status: 200, body: issueResult() });
    await c.issue(fields);
    expect(write).toHaveBeenCalledTimes(2);
    expect(c.snapshot().phase).toBe('SAVED');
  },
);
it('still clears private context on a missing read', async () => {
  read.mockResolvedValue({ status: 404, body: null });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.load({ version: 'v1', submissionId: context.page.submissionId, after: null });
  expect(c.snapshot()).toMatchObject({ phase: 'DENIED', context: null, outcome: null });
  expect(write).not.toHaveBeenCalled();
});
it('retains colliding intent locked instead of silently creating a new key', async () => {
  write.mockResolvedValue({ status: 409, body: { error: { code: 'IDEMPOTENCY_KEY_REUSED' } } });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.issue(fields);
  expect(c.snapshot().phase).toBe('BLOCKED');
  await c.load({ version: 'v1', submissionId: null, after: null });
  await c.issue(fields);
  expect(read).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledOnce();
});
it.each([
  ['UNCERTAIN', () => write.mockRejectedValueOnce(new Error('private secret')), 'ISSUE'],
  [
    'BLOCKED',
    () =>
      write.mockResolvedValueOnce({
        status: 409,
        body: { error: { code: 'IDEMPOTENCY_KEY_REUSED' } },
      }),
    'REVOKE',
  ],
] as const)(
  'discards a %s pending command only on explicit request, reloads the shown submission and uses a new key afterwards',
  async (phase, arrange, kind) => {
    arrange();
    key.mockReturnValueOnce('stable-key').mockReturnValueOnce('second-key');
    const c = createPracticeAssignmentManager(context, transport, key);
    if (kind === 'ISSUE') await c.issue(fields);
    else await c.revoke(id, 'Synthetic reason.');
    expect(c.snapshot().phase).toBe(phase);
    await c.discard();
    expect(read).toHaveBeenCalledExactlyOnceWith({
      version: 'v1',
      submissionId: context.page.submissionId,
      after: null,
    });
    expect(c.snapshot()).toMatchObject({ phase: 'EDITING', outcome: null });
    expect(c.snapshot().message).toMatch(/discarded.*unknown.*compare/i);
    await c.issue(fields);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][2]).toBe('second-key');
  },
);
it('ignores discard unless a command is UNCERTAIN or BLOCKED, and never discards a busy or saved command', async () => {
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.discard();
  expect(read).not.toHaveBeenCalled();
  await c.issue(fields);
  expect(c.snapshot().phase).toBe('SAVED');
  await c.discard();
  expect(read).not.toHaveBeenCalled();
  expect(c.snapshot().phase).toBe('SAVED');
});
it('clears private context when the reload after a discard is denied', async () => {
  write.mockRejectedValueOnce(new Error('x'));
  read.mockResolvedValue({ status: 403, body: null });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.issue(fields);
  await c.discard();
  expect(c.snapshot()).toMatchObject({ phase: 'DENIED', context: null });
});
it('requires refresh after already-revoked conflict', async () => {
  write.mockResolvedValue({ status: 409, body: { error: { code: 'REVISION_CHANGED' } } });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.revoke(id, 'reason');
  expect(c.snapshot().phase).toBe('STALE');
  await c.issue(fields);
  expect(write).toHaveBeenCalledOnce();
  await c.load({ version: 'v1', submissionId: context.page.submissionId, after: null });
  expect(c.snapshot().phase).toBe('EDITING');
});
it.each([413, 415, 422])('allows correcting a known invalid command HTTP%s', async (status) => {
  write.mockResolvedValue({ status, body: { error: { code: 'INVALID_COMMAND' } } });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.issue(fields);
  expect(c.snapshot().phase).toBe('EDITING');
  await c.issue({ ...fields, reason: 'Corrected' });
  expect(key).toHaveBeenCalledTimes(2);
});
it('denies new writes when current configuration is off, but current lookup still works', async () => {
  const c = createPracticeAssignmentManager(
    { ...context, writesAvailable: false, unavailableReason: 'DISABLED' },
    transport,
    key,
  );
  await c.issue(fields);
  await c.revoke(id, 'reason');
  expect(write).not.toHaveBeenCalled();
  await c.load({ version: 'v1', submissionId: null, after: null });
  expect(read).toHaveBeenCalledOnce();
});
it('validates actor/target-bound fresh lookup and clears obsolete metadata after failed lookup', async () => {
  read.mockResolvedValue({
    status: 200,
    body: { ...context, page: { ...context.page, actorAccountId: 'foreign' } },
  });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.load({ version: 'v1', submissionId: context.page.submissionId, after: null });
  expect(c.snapshot()).toMatchObject({ phase: 'UNAVAILABLE', context: null });
});
it('does not send invalid request identity or leak key-generator diagnostics', async () => {
  key.mockImplementation(() => {
    throw new Error('private secret');
  });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.issue(fields);
  expect(write).not.toHaveBeenCalled();
  expect(c.snapshot().phase).toBe('EDITING');
  expect(c.snapshot().message).not.toContain('secret');
});
it('refresh reloads the currently displayed submission from STALE, independent of any lookup text', async () => {
  write.mockResolvedValue({ status: 404, body: null });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.revoke(id, 'Synthetic reason.');
  expect(c.snapshot().phase).toBe('STALE');
  await c.refresh();
  expect(read).toHaveBeenCalledExactlyOnceWith({
    version: 'v1',
    submissionId: context.page.submissionId,
    after: null,
  });
  expect(c.snapshot()).toMatchObject({ phase: 'EDITING', message: '' });
});
it('keeps the unauthenticated wording for a write 401 and uses neutral business-denial wording for a write 403, both still clearing private context', async () => {
  write.mockResolvedValue({ status: 401, body: { error: { code: 'AUTHENTICATION_REQUIRED' } } });
  const unauthenticated = createPracticeAssignmentManager(context, transport, key);
  await unauthenticated.issue(fields);
  expect(unauthenticated.snapshot()).toMatchObject({
    phase: 'DENIED',
    context: null,
    outcome: null,
  });
  expect(unauthenticated.snapshot().message).toMatch(/sign in with an authorized administrator/i);
  write.mockResolvedValue({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
  const denied = createPracticeAssignmentManager(context, transport, key);
  await denied.issue(fields);
  expect(denied.snapshot()).toMatchObject({ phase: 'DENIED', context: null, outcome: null });
  expect(denied.snapshot().message).toMatch(/current account or the selected appointee/i);
  expect(denied.snapshot().message).not.toMatch(/sign in with an authorized administrator/i);
  await denied.retry();
  expect(write).toHaveBeenCalledTimes(2);
});
it('keeps the access-recheck wording when a fresh read is forbidden', async () => {
  read.mockResolvedValue({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
  const c = createPracticeAssignmentManager(context, transport, key);
  await c.load({ version: 'v1', submissionId: context.page.submissionId, after: null });
  expect(c.snapshot()).toMatchObject({ phase: 'DENIED', context: null });
  expect(c.snapshot().message).toMatch(/sign in with an authorized administrator/i);
});
