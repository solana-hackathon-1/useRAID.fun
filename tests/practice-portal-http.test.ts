import { describe, it, expect, vi } from 'vitest';
import {
  createPracticePortalHandlers,
  PracticePortalHttpError,
} from '../src/skills/practice-portal-http';
import { PracticeTrialAttemptStorageError } from '../src/skills/practice-trial-attempt-storage';
import { PracticeTrialSubmissionStorageError } from '../src/skills/practice-trial-submission-storage';
import { definition } from '../examples/skill-assessments/fixtures';
import { readBoundedJson, JsonBodyFailure } from '../src/http-contracts/json';
const actor = { accountId: 'actual-user', sessionHash: 'a'.repeat(64) },
  startId = '44444444-4444-4444-8444-444444444444',
  participantId = '55555555-5555-4555-8555-555555555555';
const start = {
  version: 'v1',
  id: startId,
  state: 'STARTED',
  participantId,
  definition,
  taxonomyReference: { recordId: 'catalog', revision: 1 },
  accommodationReference: null,
  attemptNumber: 1,
  startedAt: '2026-10-15T23:00:00.000Z',
  persisted: true,
  verifiesSkill: false,
  isAuthorizationToken: false,
  createsPermissionGrant: false,
  consumesCapacity: false,
  createsFinancialObligation: false,
};
const input = {
  version: 'v1',
  definitionReference: definition.reference,
  accommodationReference: null,
};
const submissionInput = {
  version: 'v1',
  startId,
  expectedDefinitionReference: definition.reference,
  expectedRubricReference: definition.rubric.reference,
  answer: ' \n<script>literal</script>\r\n',
  explanation: 'Exact own explanation',
  toolsUsed: ['editor'],
  aiAssistanceUsed: true,
  assistanceDisclosure: 'Declared assistance, no automatic compliance.',
};
const submission = {
  version: 'v1',
  reference: { recordId: '66666666-6666-4666-8666-666666666666', revision: 1 },
  startId,
  participantId,
  skillId: definition.skillId,
  skillDomain: definition.skillDomain,
  definitionReference: definition.reference,
  rubricReference: definition.rubric.reference,
  state: 'SUBMITTED',
  submittedAt: '2026-10-15T23:01:00.000Z',
  answer: submissionInput.answer,
  explanation: submissionInput.explanation,
  toolsUsed: submissionInput.toolsUsed,
  aiAssistanceUsed: true,
  assistanceDisclosure: submissionInput.assistanceDisclosure,
  ownership: 'UNCONFIRMED',
  persisted: true,
  verifiesSkill: false,
  isAuthorizationToken: false,
  createsPermissionGrant: false,
  consumesCapacity: false,
  createsFinancialObligation: false,
};
function setup() {
  const host = {
    version: 'v1' as const,
    requestId: () => 'request-1',
    actor: vi.fn(async () => actor),
    checkOrigin: vi.fn(),
    rateLimit: vi.fn(),
    list: vi.fn(async () => ({
      version: 'v1',
      taxonomyId: 'catalog',
      trials: [],
      nextCursor: null,
    })),
    read: vi.fn(async () => ({ version: 'v1', progress: 'SUBMITTED', start, submission })),
    start: vi.fn(async () => ({
      version: 'v1',
      status: 'EXECUTED',
      start,
      writesAvailable: true,
      unavailableReason: null,
    })),
    submit: vi.fn(async () => ({
      version: 'v1',
      status: 'EXECUTED',
      submission,
      writesAvailable: true,
      unavailableReason: null,
    })),
  };
  return { host, handlers: createPracticePortalHandlers(host) };
}
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://example.test/api/v1/practice/starts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'stable-key', ...headers },
    body: JSON.stringify(body),
  });
const get = (suffix = '') => new Request('https://example.test/api/v1/practice' + suffix);
function privateResponse(r: Response) {
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(r.headers.get('vary')).toBe('Cookie');
}
describe('T013D8 portable private practice HTTP', () => {
  it('routes exact own actor/source/key through invariant-owning start command', async () => {
    const { host, handlers } = setup();
    const r = await handlers.START(request(input));
    expect(r.status).toBe(200);
    privateResponse(r);
    expect(host.start).toHaveBeenCalledWith({
      actor,
      input,
      idempotencyKey: 'stable-key',
      requestId: 'request-1',
    });
    expect(await r.json()).toMatchObject({ start: { id: startId }, status: 'EXECUTED' });
  });
  it('preserves exact private submission bytes and truthful AI declaration', async () => {
    const { host, handlers } = setup();
    const r = await handlers.SUBMIT(request(submissionInput), startId);
    expect(r.status).toBe(200);
    expect(host.submit).toHaveBeenCalledWith({
      actor,
      input: submissionInput,
      idempotencyKey: 'stable-key',
      requestId: 'request-1',
    });
    expect((await r.json()).submission.answer).toBe(submissionInput.answer);
    privateResponse(r);
  });
  it('delivers only owned validated progress with coherent original consent and source', async () => {
    const { handlers } = setup();
    const r = await handlers.READ(get(), startId);
    expect(r.status).toBe(200);
    expect((await r.json()).progress).toBe('SUBMITTED');
    privateResponse(r);
  });
  it.each(['actor', 'rateLimit'] as const)(
    'denies %s before private resource or command work',
    async (field) => {
      const { host, handlers } = setup();
      host[field].mockImplementation(() => {
        throw new PracticePortalHttpError(field === 'actor' ? 401 : 429);
      });
      const r = await handlers.READ(get(), startId);
      expect(r.status).toBe(field === 'actor' ? 401 : 429);
      expect(host.read).not.toHaveBeenCalled();
      privateResponse(r);
    },
  );
  it('checks origin before reading body or dispatching a write', async () => {
    const { host, handlers } = setup();
    host.checkOrigin.mockImplementation(() => {
      throw new PracticePortalHttpError(403);
    });
    const r = await handlers.START(request(input));
    expect(r.status).toBe(403);
    expect(host.start).not.toHaveBeenCalled();
    privateResponse(r);
  });
  it.each(['participantId', 'actor', 'assessment', 'verifiedRank'])(
    'rejects caller-forged %s',
    async (field) => {
      const { host, handlers } = setup();
      const r = await handlers.START(request({ ...input, [field]: 'forged' }));
      expect(r.status).toBe(422);
      expect(host.start).not.toHaveBeenCalled();
    },
  );
  it('rejects private query selectors and binds submitted start to path', async () => {
    const { host, handlers } = setup();
    expect((await handlers.READ(get('?participantId=foreign'), startId)).status).toBe(422);
    expect(
      (await handlers.SUBMIT(request(submissionInput), '77777777-7777-4777-8777-777777777777'))
        .status,
    ).toBe(422);
    expect(host.read).not.toHaveBeenCalled();
    expect(host.submit).not.toHaveBeenCalled();
  });
  it.each(['start', 'submit'])(
    'rejects incoherent %s output without private leakage',
    async (field) => {
      const { host, handlers } = setup();
      if (field === 'start')
        host.start.mockResolvedValue({
          ...(await host.start()),
          start: {
            ...start,
            definition: { ...definition, reference: { recordId: 'foreign', revision: 9 } },
          },
        });
      else
        host.submit.mockResolvedValue({
          ...(await host.submit()),
          submission: { ...submission, answer: 'private foreign bytes' },
        });
      const r =
        field === 'start'
          ? await handlers.START(request(input))
          : await handlers.SUBMIT(request(submissionInput), startId);
      expect(r.status).toBe(503);
      expect(await r.text()).not.toContain('private foreign bytes');
    },
  );
  it('rejects cross-participant or rubric-mismatched progress from a faulty host', async () => {
    const { host, handlers } = setup();
    host.read.mockResolvedValue({
      version: 'v1',
      progress: 'SUBMITTED',
      start,
      submission: { ...submission, participantId: '77777777-7777-4777-8777-777777777777' },
    });
    expect((await handlers.READ(get(), startId)).status).toBe(503);
  });
  it('maps missing resource/current conflict and sanitizes unavailable internal failures', async () => {
    const { host, handlers } = setup();
    host.start.mockRejectedValue(new PracticeTrialAttemptStorageError('REVISION_CHANGED'));
    expect((await handlers.START(request(input))).status).toBe(409);
    host.submit.mockRejectedValue(new PracticeTrialSubmissionStorageError('ALREADY_SUBMITTED'));
    expect((await handlers.SUBMIT(request(submissionInput), startId)).status).toBe(409);
    host.read.mockRejectedValue(Error('private connection credentials'));
    const r = await handlers.READ(get(), startId);
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain('credentials');
    privateResponse(r);
  });
  it('accepts valid maximum-size Unicode answer above old16KiB HTTP cap', async () => {
    const { host, handlers } = setup();
    const body = { ...submissionInput, answer: '😀'.repeat(20000) };
    host.submit.mockResolvedValue({
      ...(await host.submit()),
      submission: { ...submission, answer: body.answer },
    });
    const r = await handlers.SUBMIT(request(body), startId);
    expect(r.status).toBe(200);
    expect(host.submit).toHaveBeenCalled();
  });
  it('rejects oversized streamed body, missing key and wrong content type before host writes', async () => {
    const { host, handlers } = setup();
    expect((await handlers.START(request({ ...input, extra: 'x'.repeat(530000) }))).status).toBe(
      413,
    );
    expect((await handlers.START(request(input, { 'Idempotency-Key': '' }))).status).toBe(422);
    expect((await handlers.START(request(input, { 'Content-Type': 'text/plain' }))).status).toBe(
      415,
    );
    expect(host.start).not.toHaveBeenCalled();
  });
  it('lists safe bounded catalog and accepts only an exclusive after cursor', async () => {
    const { host, handlers } = setup();
    const r = await handlers.LIST(get('?after=trial-1'));
    expect(r.status).toBe(200);
    expect(host.list).toHaveBeenCalledWith(actor, 'trial-1');
    expect((await handlers.LIST(get('?after=a&after=b'))).status).toBe(422);
    expect((await handlers.LIST(get('?catalogId=foreign'))).status).toBe(422);
    privateResponse(r);
  });
});
describe('bounded JSON explicit transport limit', () => {
  it('preserves default16KiB and allows explicitly bounded larger feature payload', async () => {
    const r = () => request({ answer: 'x'.repeat(20000) });
    await expect(readBoundedJson(r())).rejects.toBeInstanceOf(JsonBodyFailure);
    expect(await readBoundedJson(r(), { maximumBytes: 524288 })).toEqual({
      answer: 'x'.repeat(20000),
    });
  });
  it.each([0, -1, 1.5, 1048577, NaN])('rejects invalid host maximum %s', async (maximumBytes) => {
    await expect(readBoundedJson(request(input), { maximumBytes })).rejects.toBeInstanceOf(
      JsonBodyFailure,
    );
  });
});
