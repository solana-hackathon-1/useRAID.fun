import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  createPracticeOwnershipHandlers,
  PracticeOwnershipHttpError,
} from '../src/skills/practice-ownership-http';
import { PracticeTrialOwnershipError } from '../src/skills/practice-trial-ownership-storage';
import { CommandReceiptError } from '../src/command-receipts';
const actor = { accountId: 'evaluator', sessionHash: 'a'.repeat(64) };
const params = { assignmentId: randomUUID(), submissionId: randomUUID() };
const reference = (recordId = randomUUID(), revision = 1) => ({ recordId, revision });
const input = {
  version: 'v1',
  ...params,
  expectedSubmissionReference: reference(params.submissionId),
  expectedDefinitionReference: reference(),
  expectedRubricReference: reference(),
  expectedPolicyReference: reference(),
  expectedOwnershipReference: null,
  decision: 'CONFIRM',
  reason: 'private-reason',
  observations: [{ kind: 'EXPLANATION', detail: 'private-observation' }],
};
const record = {
  version: 'v1',
  id: randomUUID(),
  reference: reference(params.submissionId),
  submissionReference: input.expectedSubmissionReference,
  participantId: randomUUID(),
  definitionReference: input.expectedDefinitionReference,
  rubricReference: input.expectedRubricReference,
  skillId: 'frontend',
  skillDomain: 'web',
  assignmentId: params.assignmentId,
  policyVersionId: randomUUID(),
  policyReference: input.expectedPolicyReference,
  evaluatorAccountId: actor.accountId,
  decision: input.decision,
  ownership: 'CONFIRMED',
  reason: input.reason,
  observations: input.observations,
  caseAccessId: randomUUID(),
  policyAccessId: randomUUID(),
  reviewedAt: '2026-10-21T00:00:00.000Z',
  persisted: true,
  verifiesSkill: false,
  isAuthorizationToken: false,
  createsPermissionGrant: false,
  consumesCapacity: false,
  createsFinancialObligation: false,
};
const view = {
  version: 'v1',
  private: true,
  record,
  currentReference: record.reference,
  isCurrent: true,
  accessId: randomUUID(),
  isAuthorizationToken: false,
};
const readResult = { version: 'v1', readsAvailable: true, unavailableReason: null, view };
const writeResult = { ...readResult, status: 'EXECUTED', writesAvailable: true };
const host = {
  version: 'v1' as const,
  actor: vi.fn(),
  origin: vi.fn(),
  rateLimit: vi.fn(),
  read: vi.fn(),
  record: vi.fn(),
  requestId: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  host.actor.mockResolvedValue(actor);
  host.read.mockResolvedValue(readResult);
  host.record.mockResolvedValue(writeResult);
  host.requestId.mockReturnValue('request-1');
});
const handlers = () => createPracticeOwnershipHandlers(host);
const get = (query = '?purpose=OWNERSHIP_REVIEW', path: unknown = Promise.resolve(params)) =>
  handlers().GET(new Request('http://localhost/ownership' + query), path);
const post = (
  body: unknown = input,
  options: {
    query?: string;
    key?: string | null;
    headers?: Record<string, string>;
    path?: unknown;
    raw?: string;
  } = {},
) =>
  handlers().POST(
    new Request('http://localhost/ownership' + (options.query ?? ''), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.key === null ? {} : { 'Idempotency-Key': options.key ?? 'stable-key' }),
        ...options.headers,
      },
      body: options.raw ?? JSON.stringify(body),
    }),
    options.path ?? Promise.resolve(params),
  );
async function denied(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  const text = await response.text();
  for (const secret of [
    'private-reason',
    'private-observation',
    actor.sessionHash,
    'private-diagnostic',
  ])
    expect(text).not.toContain(secret);
  const body = JSON.parse(text);
  if (code) expect(body.error.code).toBe(code);
  return body;
}
it('reads canonical current finding via explicit assignment and purpose with private headers', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(readResult);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(host.read).toHaveBeenCalledExactlyOnceWith(actor, {
    version: 'v1',
    ...params,
    purpose: 'OWNERSHIP_REVIEW',
  });
  expect(host.rateLimit).toHaveBeenCalledExactlyOnceWith(actor);
  expect(host.origin).not.toHaveBeenCalled();
});
it('reads historical finding by another author/assignment through current assessment appointment', async () => {
  host.read.mockResolvedValue({
    ...readResult,
    view: {
      ...view,
      isCurrent: false,
      currentReference: reference(params.submissionId, 2),
      record: { ...record, evaluatorAccountId: 'previous-author', assignmentId: randomUUID() },
    },
  });
  const response = await get('?purpose=ASSESSMENT_REVIEW&revision=1');
  expect(response.status).toBe(200);
  expect(host.read).toHaveBeenCalledWith(actor, {
    version: 'v1',
    ...params,
    purpose: 'ASSESSMENT_REVIEW',
    revision: 1,
  });
});
it('records normalized canonical reason and observations using actual actor and stable command key', async () => {
  const response = await post({ ...input, reason: '  ' + input.reason + '  ' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(writeResult);
  expect(host.record).toHaveBeenCalledExactlyOnceWith({
    actor,
    input,
    idempotencyKey: 'stable-key',
    requestId: 'request-1',
  });
  expect(host.origin.mock.invocationCallOrder[0]).toBeLessThan(
    host.actor.mock.invocationCallOrder[0],
  );
  expect(host.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
    host.record.mock.invocationCallOrder[0],
  );
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
});
it('permits original historical replay while new writes disabled', async () => {
  const result = {
    ...writeResult,
    status: 'REPLAYED',
    writesAvailable: false,
    unavailableReason: 'DISABLED',
    view: { ...view, isCurrent: false, currentReference: reference(params.submissionId, 2) },
  };
  host.record.mockResolvedValue(result);
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
});
it.each(['EXECUTED', 'REPLAYED'])(
  'retains committed %s status without private body after read gate closes',
  async (status) => {
    const result = {
      ...writeResult,
      status,
      view: null,
      readsAvailable: false,
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    };
    host.record.mockResolvedValue(result);
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  },
);
it('does not confuse write availability with committed outcome or read availability', async () => {
  const result = { ...writeResult, writesAvailable: false, unavailableReason: 'DISABLED' };
  host.record.mockResolvedValue(result);
  expect(await (await post()).json()).toEqual(result);
});
it.each([
  '',
  '?purpose=OTHER',
  '?purpose=OWNERSHIP_REVIEW&purpose=OWNERSHIP_REVIEW',
  '?purpose=OWNERSHIP_REVIEW&actor=evaluator',
  '?purpose=OWNERSHIP_REVIEW&revision=01',
  '?purpose=OWNERSHIP_REVIEW&revision=1e0',
  '?purpose=OWNERSHIP_REVIEW&revision=0',
  '?purpose=OWNERSHIP_REVIEW&revision=-1',
  '?purpose=OWNERSHIP_REVIEW&revision=2147483648',
  '?purpose=OWNERSHIP_REVIEW&revision=1&revision=2',
])('rejects invalid read query %s', async (query) => {
  await denied(await get(query), 422);
  expect(host.read).not.toHaveBeenCalled();
});
it.each([{}, null, { ...params, assignmentId: 'bad' }, { ...params, actor: 'forged' }])(
  'rejects malformed path %j',
  async (path) => {
    await denied(await get(undefined, path), 422);
    await denied(await post(input, { path: Promise.resolve(path) }), 422);
    expect(host.read).not.toHaveBeenCalled();
    expect(host.record).not.toHaveBeenCalled();
  },
);
it.each([
  { ...input, submissionId: randomUUID() },
  { ...input, assignmentId: randomUUID() },
  { ...input, actor },
  { ...input, purpose: 'ASSESSMENT_REVIEW' },
  { ...input, reason: ' ' },
  { ...input, observations: [] },
  { ...input, reason: '\ud800' },
])('rejects forged/malformed finding body %#', async (body) => {
  await denied(await post(body), 422);
  expect(host.record).not.toHaveBeenCalled();
});
it.each([null, '', 'bad key', 'x'.repeat(201)])(
  'requires valid stable command key %s',
  async (key) => {
    await denied(await post(input, { key }), 422);
    expect(host.record).not.toHaveBeenCalled();
  },
);
it('rejects unknown write query before command', async () => {
  await denied(await post(input, { query: '?purpose=OWNERSHIP_REVIEW' }), 422);
  expect(host.record).not.toHaveBeenCalled();
});
it.each([
  [{ raw: '{' }, 422],
  [{ headers: { 'Content-Type': 'text/plain' } }, 415],
  [{ raw: ' '.repeat(262145) }, 413],
  [{ headers: { 'Content-Length': '262145' } }, 413],
] as const)('enforces bounded strict JSON %#', async (options, status) => {
  await denied(await post(input, options), status);
  expect(host.record).not.toHaveBeenCalled();
});
it('checks origin before private authentication or streamed body', async () => {
  host.origin.mockRejectedValue(new PracticeOwnershipHttpError(403));
  await denied(await post(input, { raw: '{' }), 403);
  expect(host.actor).not.toHaveBeenCalled();
  expect(host.record).not.toHaveBeenCalled();
});
it.each([401, 403, 429] as const)('sanitizes authority %s before source', async (status) => {
  host.actor.mockRejectedValue(new PracticeOwnershipHttpError(status));
  await denied(await get(), status);
  await denied(await post(), status);
  expect(host.read).not.toHaveBeenCalled();
  expect(host.record).not.toHaveBeenCalled();
});
it('limits account before source', async () => {
  host.rateLimit.mockRejectedValue(new PracticeOwnershipHttpError(429));
  await denied(await post(), 429);
  expect(host.record).not.toHaveBeenCalled();
});
it('rejects malformed host actor', async () => {
  host.actor.mockResolvedValue({ ...actor, admin: true });
  await denied(await post(), 503);
  expect(host.record).not.toHaveBeenCalled();
});
it.each([
  ['AUTHENTICATION_REQUIRED', 401],
  ['ACCOUNT_RESTRICTED', 403],
  ['RESOURCE_UNAVAILABLE', 404],
  ['WRITES_DISABLED', 503],
  ['REVISION_CHANGED', 409],
  ['INVALID_INPUT', 422],
  ['STORAGE_CONTRACT', 503],
  ['STORAGE_UNAVAILABLE', 503],
] as const)('maps canonical storage error %s without private diagnostics', async (code, status) => {
  host.record.mockRejectedValue(new PracticeTrialOwnershipError(code));
  await denied(await post(), status);
  host.read.mockRejectedValue(new PracticeTrialOwnershipError(code));
  await denied(await get(), status);
});
it('maps changed same-key command to safe409', async () => {
  host.record.mockRejectedValue(new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'));
  await denied(await post(), 409, 'IDEMPOTENCY_KEY_REUSED');
});
it.each([
  new Error('private-diagnostic'),
  { code: 'AUTHENTICATION_REQUIRED', message: 'private-diagnostic' },
  new CommandReceiptError('STORAGE_UNAVAILABLE'),
])('sanitizes untrusted exceptions %#', async (error) => {
  host.record.mockRejectedValue(error);
  await denied(await post(), 503);
});
it('contains rejected async params even when auth denies first; fallback requestId safe', async () => {
  host.actor.mockRejectedValue(new PracticeOwnershipHttpError(401));
  host.requestId.mockImplementation(() => {
    throw new Error('private-diagnostic');
  });
  const body = await denied(
    await get(undefined, Promise.reject(new Error('private-diagnostic'))),
    401,
  );
  expect(body.error.requestId).toMatch(/^[a-f0-9-]{36}$/);
});
it('returns non-enumerable404 for absent current finding', async () => {
  host.read.mockResolvedValue({ ...readResult, view: null });
  await denied(await get(), 404, 'NOT_FOUND');
});
it.each([
  { ...readResult, view: null, readsAvailable: false, unavailableReason: 'DISABLED' },
  { ...readResult, readsAvailable: false, unavailableReason: 'DISABLED' },
  { ...readResult, unavailableReason: 'DISABLED' },
  { ...readResult, secret: 'private-diagnostic' },
  { ...readResult, view: { ...view, record: { ...record, secret: 'private-diagnostic' } } },
  {
    ...readResult,
    view: {
      ...view,
      record: { ...record, reference: reference(), submissionReference: reference() },
    },
  },
  {
    ...readResult,
    view: { ...view, isCurrent: false, currentReference: reference(params.submissionId, 2) },
  },
])('fails closed on malformed/disabled/wrong current read output %#', async (output) => {
  host.read.mockResolvedValue(output);
  await denied(await get(), 503);
});
it('rejects host returning another historical revision', async () => {
  await denied(await get('?purpose=OWNERSHIP_REVIEW&revision=2'), 503);
});
it.each([
  { ...writeResult, view: null },
  { ...writeResult, readsAvailable: false },
  { ...writeResult, unavailableReason: 'DISABLED' },
  { ...writeResult, status: 'UNKNOWN' },
  { ...writeResult, secret: 'private-diagnostic' },
  {
    ...writeResult,
    view: { ...view, isCurrent: false, currentReference: reference(params.submissionId, 2) },
  },
  ...[
    'assignmentId',
    'evaluatorAccountId',
    'reason',
    'observations',
    'submissionReference',
    'definitionReference',
    'rubricReference',
    'policyReference',
    'reference',
    'decision',
  ].map((key) => ({
    ...writeResult,
    view: {
      ...view,
      record: {
        ...record,
        [key]:
          key === 'observations'
            ? [{ kind: 'OTHER', detail: 'different' }]
            : key.endsWith('Reference') || key === 'reference'
              ? reference()
              : key === 'assignmentId'
                ? randomUUID()
                : key === 'decision'
                  ? 'DISPUTE'
                  : 'different',
      },
    },
  })),
])('fails closed on malformed/mismatched command output %#', async (output) => {
  host.record.mockResolvedValue(output);
  await denied(await post(), 503);
});
it.each(['origin', 'actor', 'rateLimit', 'read', 'record', 'requestId', 'version'])(
  'rejects missing host port %s',
  (key) => {
    expect(() => createPracticeOwnershipHandlers({ ...host, [key]: undefined } as never)).toThrow(
      'STORAGE_CONTRACT',
    );
  },
);
it('rejects an internally coherent finding for a different submission', async () => {
  const foreign = reference();
  host.read.mockResolvedValue({
    ...readResult,
    view: {
      ...view,
      currentReference: foreign,
      record: { ...record, reference: foreign, submissionReference: foreign },
    },
  });
  await denied(await get(), 503);
});
it('supports framework-generated HEAD with the same current read authority', async () => {
  const response = await handlers().GET(
    new Request('http://localhost/ownership?purpose=OWNERSHIP_REVIEW', { method: 'HEAD' }),
    Promise.resolve(params),
  );
  expect(response.status).toBe(200);
  expect(host.read).toHaveBeenCalledTimes(1);
});
it('rejects unsupported methods without storage and declares supported methods', async () => {
  const response = await handlers().GET(
    new Request('http://localhost/ownership?purpose=OWNERSHIP_REVIEW', { method: 'DELETE' }),
    params,
  );
  await denied(response, 405);
  expect(response.headers.get('allow')).toBe('GET, POST');
  expect(host.read).not.toHaveBeenCalled();
});
