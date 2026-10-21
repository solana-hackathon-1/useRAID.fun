import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  createPracticeAssessmentHandlers,
  PracticeAssessmentHttpError,
} from '../src/skills/practice-assessment-http';
import { PracticeTrialAssessmentError } from '../src/skills/practice-trial-assessment-storage';
import { CommandReceiptError } from '../src/command-receipts';
import {
  assessmentHttpActor as actor,
  assessmentHttpParams as params,
  assessmentReviewInput as reviewInput,
  assessmentReviewView as reviewView,
  assessmentStateView as stateView,
  assessmentDecisionInput as decisionInput,
  assessmentDecisionView as decisionView,
} from './helpers/practice-assessment-http-fixture';
// Tests deliberately mutate canonical fixtures into invalid host results.
type MutableView = Omit<typeof reviewView, 'assessment'> &
  Omit<typeof stateView, 'assessment'> &
  Omit<typeof decisionView, 'assessment'> & { assessment: { evaluatorAccountId: string } };
const host = {
  version: 'v1' as const,
  requestId: vi.fn(),
  origin: vi.fn(),
  actor: vi.fn(),
  rateLimit: vi.fn(),
  readReview: vi.fn(),
  recordReview: vi.fn(),
  readState: vi.fn(),
  readDecision: vi.fn(),
  recordDecision: vi.fn(),
};
const readResult = (view: unknown) => ({
  version: 'v1',
  readsAvailable: true,
  unavailableReason: null,
  view,
});
const writeResult = (view: unknown) => ({
  ...readResult(view),
  status: 'EXECUTED',
  writesAvailable: true,
});
const modes = [
  {
    key: 'review' as const,
    read: host.readReview,
    record: host.recordReview,
    input: reviewInput,
    view: reviewView,
    recordField: 'review',
  },
  {
    key: 'state' as const,
    read: host.readState,
    record: null,
    input: null,
    view: stateView,
    recordField: 'assessment',
  },
  {
    key: 'decisions' as const,
    read: host.readDecision,
    record: host.recordDecision,
    input: decisionInput,
    view: decisionView,
    recordField: 'decision',
  },
];
beforeEach(() => {
  vi.resetAllMocks();
  host.actor.mockResolvedValue(actor);
  host.requestId.mockReturnValue('request-1');
  for (const m of modes) {
    m.read.mockResolvedValue(readResult(m.view));
    m.record?.mockResolvedValue(writeResult(m.view));
  }
});
function get(
  key: (typeof modes)[number]['key'],
  query = '',
  path: unknown = params,
  method = 'GET',
) {
  return createPracticeAssessmentHandlers(host)[key].GET(
    new Request('http://localhost/assessment' + query, { method }),
    path,
  );
}
function post(
  key: 'review' | 'decisions',
  body: unknown,
  options: {
    path?: unknown;
    query?: string;
    key?: string | null;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
) {
  return createPracticeAssessmentHandlers(host)[key].POST(
    new Request('http://localhost/assessment' + (options.query ?? ''), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.key === null ? {} : { 'Idempotency-Key': options.key ?? 'stable-key' }),
        ...options.headers,
      },
      body: options.raw ?? JSON.stringify(body),
    }),
    options.path ?? params,
  );
}
async function denied(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  const text = await response.text();
  for (const secret of [
    'private-reason',
    'private-confidence',
    'private-criterion',
    'private-decision-reason',
    'private-finding',
    'private-diagnostic',
    actor.sessionHash,
  ])
    expect(text).not.toContain(secret);
  const b = JSON.parse(text);
  if (code) expect(b.error.code).toBe(code);
  return b;
}
for (const m of modes) {
  it(m.key + ' reads current result through actual scoped host and private headers', async () => {
    const r = await get(m.key);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(readResult(m.view));
    expect(m.read).toHaveBeenCalledExactlyOnceWith(actor, { version: 'v1', ...params });
    expect(host.rateLimit).toHaveBeenCalledExactlyOnceWith(actor);
    expect(host.origin).not.toHaveBeenCalled();
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('vary')).toBe('Cookie');
  });
  it(m.key + ' accepts explicit historical revision under current reader authority', async () => {
    const v = structuredClone(m.view) as unknown as MutableView;
    if (m.key === 'review') {
      v.currentReviewReference = { ...v.currentReviewReference, revision: 3 };
      v.isCurrentReview = false;
      v.currentAssessmentReference = { ...v.currentAssessmentReference, revision: 5 };
      v.isCurrentAssessment = false;
      v.review.assignmentId = randomUUID();
      v.review.evaluatorAccountId = 'old-author';
      v.assessment.evaluatorAccountId = 'old-author';
    } else {
      v.currentAssessmentReference = { ...v.currentAssessmentReference, revision: 5 };
      v.isCurrent = false;
      if (m.key === 'decisions') {
        v.decision.assignmentId = randomUUID();
        v.decision.evaluatorAccountId = 'old-author';
        v.assessment.evaluatorAccountId = 'old-author';
      }
    }
    m.read.mockResolvedValue(readResult(v));
    const rev = m.key === 'decisions' ? 2 : 1;
    expect((await get(m.key, '?revision=' + rev)).status).toBe(200);
    expect(m.read).toHaveBeenCalledExactlyOnceWith(actor, {
      version: 'v1',
      ...params,
      revision: rev,
    });
  });
  it.each([
    '?revision=01',
    '?revision=0',
    '?revision=-1',
    '?revision=1e0',
    '?revision=2147483648',
    '?revision=1&revision=2',
    '?purpose=ASSESSMENT_REVIEW',
    '?actor=forged',
  ])(m.key + ' rejects invalid query %s', async (q) => {
    await denied(await get(m.key, q), 422);
    expect(m.read).not.toHaveBeenCalled();
  });
  it.each([{}, null, { ...params, assignmentId: 'bad' }, { ...params, actor: 'forged' }])(
    m.key + ' rejects malformed path %#',
    async (path) => {
      await denied(await get(m.key, '', path), 422);
      expect(m.read).not.toHaveBeenCalled();
    },
  );
  it(m.key + ' returns non-enumerable missing404 and unavailable503', async () => {
    m.read.mockResolvedValue({ ...readResult(null) });
    await denied(await get(m.key), 404, 'NOT_FOUND');
    m.read.mockResolvedValue({
      ...readResult(null),
      readsAvailable: false,
      unavailableReason: 'DISABLED',
    });
    await denied(await get(m.key), 503);
  });
  it(m.key + ' binds source and requested revision/currentness', async () => {
    await denied(await get(m.key, '?revision=10'), 503);
    const v = structuredClone(m.view) as unknown as MutableView;
    if (m.key === 'review') {
      v.currentReviewReference = { ...v.currentReviewReference, revision: 3 };
      v.isCurrentReview = false;
    } else {
      v.currentAssessmentReference = { ...v.currentAssessmentReference, revision: 5 };
      v.isCurrent = false;
    }
    m.read.mockResolvedValue(readResult(v));
    await denied(await get(m.key), 503);
  });
  it.each([401, 403, 429] as const)(
    m.key + ' denies authority %s before reading',
    async (status) => {
      host.actor.mockRejectedValue(new PracticeAssessmentHttpError(status));
      await denied(await get(m.key), status);
      expect(m.read).not.toHaveBeenCalled();
    },
  );
  it(m.key + ' sanitizes arbitrary host exceptions and contains rejected params', async () => {
    host.actor.mockRejectedValue(new Error('private-diagnostic'));
    host.requestId.mockImplementation(() => {
      throw new Error('private-diagnostic');
    });
    await denied(await get(m.key, '', Promise.reject(new Error('private-diagnostic'))), 503);
  });
  it(m.key + ' supports HEAD with the same read authority and rejects other verbs', async () => {
    expect((await get(m.key, '', params, 'HEAD')).status).toBe(200);
    m.read.mockClear();
    await denied(await get(m.key, '', params, 'DELETE'), 405);
    expect(m.read).not.toHaveBeenCalled();
  });
  it.each([
    { extra: 'private-diagnostic' },
    { readsAvailable: false },
    { unavailableReason: 'DISABLED' },
  ])(m.key + ' rejects malformed output envelope %#', async (extra) => {
    m.read.mockResolvedValue({ ...readResult(m.view), ...extra });
    await denied(await get(m.key), 503);
  });
  if (m.record && m.input) {
    const key = m.key as 'review' | 'decisions',
      input = m.input,
      record = m.record;
    it(
      key + ' normalizes and saves with server actor, original stable key and origin first',
      async () => {
        const r = await post(key, { ...input, reason: '  ' + input.reason + '  ' });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual(writeResult(m.view));
        expect(record).toHaveBeenCalledExactlyOnceWith({
          actor,
          input,
          idempotencyKey: 'stable-key',
          requestId: 'request-1',
        });
        expect(host.origin.mock.invocationCallOrder[0]).toBeLessThan(
          host.actor.mock.invocationCallOrder[0],
        );
        expect(host.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
          record.mock.invocationCallOrder[0],
        );
      },
    );
    it.each(['EXECUTED', 'REPLAYED'])(
      key + ' preserves committed %s with body hidden after reads close',
      async (status) => {
        const r = {
          ...writeResult(null),
          readsAvailable: false,
          status,
          writesAvailable: false,
          unavailableReason: 'DISABLED',
        };
        record.mockResolvedValue(r);
        expect(await (await post(key, input)).json()).toEqual(r);
      },
    );
    it(
      key + ' permits historical original replay while writes disabled/misconfigured',
      async () => {
        const v = structuredClone(m.view) as unknown as MutableView;
        if (key === 'review') {
          v.currentReviewReference = { ...v.currentReviewReference, revision: 3 };
          v.isCurrentReview = false;
          v.currentAssessmentReference = { ...v.currentAssessmentReference, revision: 5 };
          v.isCurrentAssessment = false;
        } else {
          v.currentAssessmentReference = { ...v.currentAssessmentReference, revision: 5 };
          v.isCurrent = false;
        }
        const r = {
          ...writeResult(v),
          status: 'REPLAYED',
          writesAvailable: false,
          unavailableReason: 'MISCONFIGURED',
        };
        record.mockResolvedValue(r);
        expect(await (await post(key, input)).json()).toEqual(r);
      },
    );
    it(key + ' checks origin before authentication or malformed body', async () => {
      host.origin.mockRejectedValue(new PracticeAssessmentHttpError(403));
      await denied(await post(key, input, { raw: '{' }), 403);
      expect(host.actor).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });
    it.each([null, '', 'bad key', 'x'.repeat(201)])(
      key + ' requires stable valid key %#',
      async (id) => {
        await denied(await post(key, input, { key: id }), 422);
        expect(record).not.toHaveBeenCalled();
      },
    );
    it.each([
      { submissionId: randomUUID() },
      { assignmentId: randomUUID() },
      { actor },
      { assessedRank: 'S' },
      { approved: true },
      { reason: ' ' },
      { reason: '\ud800' },
    ])(key + ' rejects forged/invalid body %#', async (extra) => {
      await denied(await post(key, { ...input, ...extra }), 422);
      expect(record).not.toHaveBeenCalled();
    });
    it.each([
      [{ raw: '{' }, 422],
      [{ headers: { 'Content-Type': 'text/plain' } }, 415],
      [{ raw: ' '.repeat(262145) }, 413],
      [{ headers: { 'Content-Length': '262145' } }, 413],
    ] as const)(key + ' enforces bounded JSON %#', async (options, status) => {
      await denied(await post(key, input, options), status);
      expect(record).not.toHaveBeenCalled();
    });
    it(key + ' denies query and account quota before storage', async () => {
      await denied(await post(key, input, { query: '?revision=1' }), 422);
      host.rateLimit.mockRejectedValue(new PracticeAssessmentHttpError(429));
      await denied(await post(key, input), 429);
      expect(record).not.toHaveBeenCalled();
    });
    it.each([
      ['INVALID_INPUT', 422, 'INVALID_COMMAND'],
      ['AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'],
      ['ACCOUNT_RESTRICTED', 403, 'ACCOUNT_RESTRICTED'],
      ['RESOURCE_UNAVAILABLE', 404, 'NOT_FOUND'],
      ['REVISION_CHANGED', 409, 'REVISION_CHANGED'],
      ['FAMILY_CHANGED', 409, 'FAMILY_CHANGED'],
      ['EVIDENCE_NOT_CONFIRMED', 422, 'EVIDENCE_NOT_CONFIRMED'],
      ['RUBRIC_NOT_MET', 422, 'RUBRIC_NOT_MET'],
      ['HIGH_RANK_EVIDENCE_REQUIRED', 422, 'HIGH_RANK_EVIDENCE_REQUIRED'],
      ['AUTOMATED_EVIDENCE_UNAVAILABLE', 503, 'AUTOMATED_EVIDENCE_UNAVAILABLE'],
      ['TOOLS_POLICY_NOT_MET', 422, 'TOOLS_POLICY_NOT_MET'],
      ['CURRENT_HIGHER_ASSESSMENT', 409, 'CURRENT_HIGHER_ASSESSMENT'],
      ['WRITES_DISABLED', 503, 'SERVICE_UNAVAILABLE'],
      ['STORAGE_CONTRACT', 503, 'SERVICE_UNAVAILABLE'],
      ['STORAGE_UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE'],
    ] as const)(key + ' maps safe canonical error %s', async (code, status, expected) => {
      record.mockRejectedValue(new PracticeTrialAssessmentError(code));
      await denied(await post(key, input), status, expected);
    });
    it(
      key + ' returns conflict for changed same-key command and sanitizes untyped diagnostics',
      async () => {
        record.mockRejectedValue(new CommandReceiptError('IDEMPOTENCY_KEY_REUSED'));
        await denied(await post(key, input), 409, 'IDEMPOTENCY_KEY_REUSED');
        record.mockRejectedValue({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'private-diagnostic',
        });
        await denied(await post(key, input), 503);
      },
    );
    it.each([
      'reason',
      'evaluatorAccountId',
      'assignmentId',
      'policyReference',
      key === 'review' ? 'confidenceStatement' : 'findings',
      key === 'review' ? 'criteria' : 'caseReviewReference',
      key === 'review' ? 'reassessmentAt' : 'ownershipReference',
    ])(key + ' rejects valid-shaped but command-mismatched %s', async (field) => {
      const v = structuredClone(m.view) as unknown as MutableView;
      const r = v[m.recordField as 'review' | 'decision'] as unknown as Record<string, unknown>;
      r[field] =
        field === 'assignmentId'
          ? randomUUID()
          : field.endsWith('Reference')
            ? { recordId: randomUUID(), revision: 1 }
            : field === 'criteria'
              ? [{ criterionId: 'behavior', result: 'MET', reason: 'different' }]
              : field === 'findings'
                ? [{ kind: 'CAPABILITY_EVIDENCE', detail: 'different' }]
                : field === 'reassessmentAt'
                  ? '2027-01-01T00:00:00.000Z'
                  : 'different';
      record.mockResolvedValue(writeResult(v));
      await denied(await post(key, input), 503);
    });
  }
}
it.each([
  'requestId',
  'origin',
  'actor',
  'rateLimit',
  'readReview',
  'recordReview',
  'readState',
  'readDecision',
  'recordDecision',
  'version',
])('requires complete trusted host %s', (key) => {
  expect(() => createPracticeAssessmentHandlers({ ...host, [key]: undefined } as never)).toThrow(
    'STORAGE_CONTRACT',
  );
});
it('rejects invalid host actor without reading or writing', async () => {
  host.actor.mockResolvedValue({ ...actor, admin: true });
  await denied(await post('review', reviewInput), 503);
  expect(host.recordReview).not.toHaveBeenCalled();
});
it('rejects mismatched decision category and capability-only fraud evidence', async () => {
  await denied(await post('decisions', { ...decisionInput, action: 'REVOKE', dueAt: null }), 422);
  await denied(
    await post('decisions', {
      ...decisionInput,
      action: 'REVOKE',
      reasonCategory: 'FRAUDULENT_ASSESSMENT_EVIDENCE',
      dueAt: null,
    }),
    422,
  );
  expect(host.recordDecision).not.toHaveBeenCalled();
});
it('does not expose a POST for state reads', () => {
  expect('POST' in createPracticeAssessmentHandlers(host).state).toBe(false);
});
it('accepts a nonverification review without silently clearing an existing assessment', async () => {
  const existing = stateView.assessment.reference;
  const input = {
    ...reviewInput,
    decision: 'MORE_EVIDENCE',
    expectedAssessmentReference: existing,
  };
  const v = {
    ...reviewView,
    review: {
      ...reviewView.review,
      decision: 'MORE_EVIDENCE',
      assessmentReference: null,
      createsVerifiedAssessment: false,
    },
    assessment: null,
    isCurrentAssessment: false,
    currentAssessmentReference: existing,
  };
  host.recordReview.mockResolvedValue(writeResult(v));
  expect(await (await post('review', input)).json()).toEqual(writeResult(v));
});
it('accepts an explicit reasoned fraud-evidence revocation with matching immutable state', async () => {
  const input = {
    ...decisionInput,
    action: 'REVOKE',
    reasonCategory: 'FRAUDULENT_ASSESSMENT_EVIDENCE',
    dueAt: null,
    findings: [{ kind: 'ASSESSMENT_EVIDENCE', detail: 'private-finding' }],
  };
  const v = {
    ...decisionView,
    decision: {
      ...decisionView.decision,
      action: input.action,
      reasonCategory: input.reasonCategory,
      dueAt: null,
      findings: input.findings,
    },
    assessment: { ...decisionView.assessment, state: 'REVOKED', reassessmentAt: null },
  };
  host.recordDecision.mockResolvedValue(writeResult(v));
  expect(await (await post('decisions', input)).json()).toEqual(writeResult(v));
});
it('binds VERIFY result to expected existing assessment ID and contiguous next version', async () => {
  const prior = { recordId: randomUUID(), revision: 4 };
  const input = { ...reviewInput, expectedAssessmentReference: prior };
  await denied(await post('review', input), 503);
  const next = { recordId: prior.recordId, revision: 5 };
  const v = {
    ...reviewView,
    review: { ...reviewView.review, assessmentReference: next },
    assessment: { ...reviewView.assessment, reference: next },
    currentAssessmentReference: next,
  };
  host.recordReview.mockResolvedValue(writeResult(v));
  expect((await post('review', input)).status).toBe(200);
});
it.each([
  { view: null },
  { readsAvailable: false },
  { writesAvailable: false },
  { status: 'UNKNOWN' },
  { extra: 'private-diagnostic' },
])('rejects incoherent write envelope %#', async (extra) => {
  host.recordReview.mockResolvedValue({ ...writeResult(reviewView), ...extra });
  await denied(await post('review', reviewInput), 503);
  host.recordDecision.mockResolvedValue({ ...writeResult(decisionView), ...extra });
  await denied(await post('decisions', decisionInput), 503);
});
it('rejects coherent foreign-case private results for every read', async () => {
  const foreign = { recordId: randomUUID(), revision: 1 };
  const review = {
    ...reviewView,
    review: {
      ...reviewView.review,
      reference: foreign,
      submissionReference: foreign,
      ownershipReference: foreign,
    },
    assessment: { ...reviewView.assessment, submissionReference: foreign },
    currentReviewReference: foreign,
  };
  host.readReview.mockResolvedValue(readResult(review));
  await denied(await get('review'), 503);
  const state = {
    ...stateView,
    assessment: { ...stateView.assessment, submissionReference: foreign },
    sourceReviewReference: foreign,
  };
  host.readState.mockResolvedValue(readResult(state));
  await denied(await get('state'), 503);
  const decision = {
    ...decisionView,
    decision: {
      ...decisionView.decision,
      submissionReference: foreign,
      caseReviewReference: foreign,
      ownershipReference: foreign,
    },
    assessment: { ...decisionView.assessment, submissionReference: foreign },
    priorAssessment: { ...decisionView.priorAssessment, submissionReference: foreign },
  };
  host.readDecision.mockResolvedValue(readResult(decision));
  await denied(await get('decisions'), 503);
});
it('rejects executed decision claiming a historical currentness observation', async () => {
  const v = {
    ...decisionView,
    currentAssessmentReference: { ...decisionView.currentAssessmentReference, revision: 3 },
    isCurrent: false,
  };
  host.recordDecision.mockResolvedValue(writeResult(v));
  await denied(await post('decisions', decisionInput), 503);
});
