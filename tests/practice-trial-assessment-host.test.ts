import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ record: vi.fn(), read: vi.fn(), observe: vi.fn(), port: {} }));
vi.mock('../src/skills/practice-trial-assessment-storage', () => ({
  recordPracticeTrialAssessment: storage.record,
  readPracticeTrialAssessment: storage.read,
  observePracticeTrialAssessmentContext: storage.observe,
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  observePracticeTrialAssessmentContextFromHost,
  practiceTrialAssessmentWriteConfiguration,
  recordPracticeTrialAssessmentFromHost,
  readPracticeTrialAssessmentFromHost,
} from '../src/lib/practice-trial-assessments-host';
const actor = { accountId: 'synthetic', sessionHash: 'a'.repeat(64) },
  command = { actor, input: {}, idempotencyKey: 'original', requestId: 'r' };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults writes off, exacttrue only, and requires explicit valid canonical catalog namespace', () => {
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'approved-catalog');
  for (const v of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('PRACTICE_TRIAL_ASSESSMENTS_ENABLED', v);
    expect(practiceTrialAssessmentWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('PRACTICE_TRIAL_ASSESSMENTS_ENABLED', 'true');
  for (const id of [undefined, '', ' bad ', '<script>']) {
    vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', id);
    expect(practiceTrialAssessmentWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'MISCONFIGURED',
    });
  }
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'approved-catalog');
  expect(practiceTrialAssessmentWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it('composes original historical retry when writes or namespace off without fabricating current verification', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  storage.record.mockResolvedValue({ status: 'REPLAYED', view: { historical: true } });
  expect(await recordPracticeTrialAssessmentFromHost(command)).toMatchObject({
    status: 'REPLAYED',
    writesAvailable: false,
  });
  const [port, c, o] = storage.record.mock.calls[0];
  expect(port).toBe(storage.port);
  expect(c).toBe(command);
  expect(o.allowNewWrites).toBe(false);
  expect(o.canRead({})).toBe(true);
  expect(o.canUsePolicy({})).toBe(true);
  expect(o.canReview({ taxonomyId: 'approved-catalog' })).toBe(false);
});
it('reads current exact canonical namespace and read/write policies on every decision check', async () => {
  vi.stubEnv('PRACTICE_TRIAL_ASSESSMENTS_ENABLED', 'true');
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'approved-catalog');
  storage.record.mockResolvedValue({ status: 'EXECUTED', view: {} });
  await recordPracticeTrialAssessmentFromHost(command);
  const o = storage.record.mock.calls[0][2];
  expect(o.allowNewWrites).toBe(true);
  expect(o.canReview({ taxonomyId: 'approved-catalog' })).toBe(true);
  expect(o.canReview({ taxonomyId: 'other' })).toBe(false);
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'other');
  expect(o.canReview({ taxonomyId: 'approved-catalog' })).toBe(false);
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
  expect(o.canRead({})).toBe(false);
  expect(o.canUsePolicy({})).toBe(false);
  expect(o.canReview({ taxonomyId: 'other' })).toBe(false);
});
it('composes actual private history without new-write gate and drops result if read scope closes before delivery', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  const body = { id: 'synthetic' };
  storage.read.mockImplementation(async (_tx, a, input, canRead) => {
    expect(a).toBe(actor);
    expect(input).toBe(body);
    expect(canRead({})).toBe(true);
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
    expect(canRead({})).toBe(false);
    return { private: true };
  });
  expect(await readPracticeTrialAssessmentFromHost(actor, body)).toMatchObject({
    view: null,
    readsAvailable: false,
  });
  expect(storage.read.mock.calls[0][0]).toBe(storage.port);
});
it('preserves successful status while dropping private delivery if reads close after a committed command', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  storage.record.mockImplementation(async () => {
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
    return { status: 'EXECUTED', view: { private: true } };
  });
  expect(await recordPracticeTrialAssessmentFromHost(command)).toMatchObject({
    status: 'EXECUTED',
    view: null,
    readsAvailable: false,
  });
  expect(storage.record).toHaveBeenCalledTimes(1);
});

it('composes initial private context observation without guessed current refs and drops metadata if reads close after commit', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  const body = { version: 'v1', assignmentId: 'synthetic', submissionId: 'synthetic' };
  storage.observe.mockImplementation(async (_tx, a, input, canRead) => {
    expect(a).toBe(actor);
    expect(input).toBe(body);
    expect(canRead({})).toBe(true);
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
    expect(canRead({})).toBe(false);
    return { private: true };
  });
  expect(await observePracticeTrialAssessmentContextFromHost(actor, body)).toMatchObject({
    context: null,
    readsAvailable: false,
  });
  expect(storage.observe.mock.calls[0][0]).toBe(storage.port);
});
