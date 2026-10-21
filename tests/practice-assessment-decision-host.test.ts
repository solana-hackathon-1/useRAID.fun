import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ record: vi.fn(), read: vi.fn(), observe: vi.fn(), port: {} }));
vi.mock('../src/skills/practice-trial-assessment-storage', () => ({
  recordPracticeAssessmentDecision: storage.record,
  readPracticeTrialAssessmentState: storage.read,
  readPracticeAssessmentDecision: storage.observe,
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  practiceAssessmentDecisionWriteConfiguration,
  recordPracticeAssessmentDecisionFromHost,
  readPracticeTrialAssessmentStateFromHost,
  readPracticeAssessmentDecisionFromHost,
} from '../src/lib/practice-assessment-decisions-host';
const actor = { accountId: 'synthetic', sessionHash: 'a'.repeat(64) },
  command = { actor, input: {}, idempotencyKey: 'original', requestId: 'r' };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults writes off, exacttrue only, and requires explicit valid canonical catalog namespace', () => {
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'approved-catalog');
  for (const v of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('PRACTICE_ASSESSMENT_DECISIONS_ENABLED', v);
    expect(practiceAssessmentDecisionWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('PRACTICE_ASSESSMENT_DECISIONS_ENABLED', 'true');
  for (const id of [undefined, '', ' bad ', '<script>']) {
    vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', id);
    expect(practiceAssessmentDecisionWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'MISCONFIGURED',
    });
  }
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'approved-catalog');
  expect(practiceAssessmentDecisionWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it('composes original historical retry when writes or namespace off without fabricating current verification', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  storage.record.mockResolvedValue({ status: 'REPLAYED', view: { historical: true } });
  expect(await recordPracticeAssessmentDecisionFromHost(command)).toMatchObject({
    status: 'REPLAYED',
    writesAvailable: false,
  });
  const [port, c, o] = storage.record.mock.calls[0];
  expect(port).toBe(storage.port);
  expect(c).toBe(command);
  expect(o.allowNewWrites).toBe(false);
  expect(o.canRead({})).toBe(true);
  expect(o.canUsePolicy({})).toBe(true);
  expect(o.canDecide({ taxonomyId: 'approved-catalog' })).toBe(false);
});
it('reads current exact canonical namespace and read/write policies on every decision check', async () => {
  vi.stubEnv('PRACTICE_ASSESSMENT_DECISIONS_ENABLED', 'true');
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'approved-catalog');
  storage.record.mockResolvedValue({ status: 'EXECUTED', view: {} });
  await recordPracticeAssessmentDecisionFromHost(command);
  const o = storage.record.mock.calls[0][2];
  expect(o.allowNewWrites).toBe(true);
  expect(o.canDecide({ taxonomyId: 'approved-catalog' })).toBe(true);
  expect(o.canDecide({ taxonomyId: 'other' })).toBe(false);
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'other');
  expect(o.canDecide({ taxonomyId: 'approved-catalog' })).toBe(false);
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
  expect(o.canRead({})).toBe(false);
  expect(o.canUsePolicy({})).toBe(false);
  expect(o.canDecide({ taxonomyId: 'other' })).toBe(false);
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
  expect(await readPracticeTrialAssessmentStateFromHost(actor, body)).toMatchObject({
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
  expect(await recordPracticeAssessmentDecisionFromHost(command)).toMatchObject({
    status: 'EXECUTED',
    view: null,
    readsAvailable: false,
  });
  expect(storage.record).toHaveBeenCalledTimes(1);
});

it('composes explicit historical decision under current read policy, then drops private delivery after commit if reads close', async () => {
  vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'true');
  const input = { version: 'v1', assignmentId: 'case', submissionId: 'submission', revision: 2 };
  storage.observe.mockImplementation(async (tx, a, i, canRead) => {
    expect(tx).toBe(storage.port);
    expect(a).toBe(actor);
    expect(i).toBe(input);
    expect(canRead({})).toBe(true);
    vi.stubEnv('PRACTICE_REVIEW_READS_ENABLED', 'false');
    expect(canRead({})).toBe(false);
    return { private: true };
  });
  expect(await readPracticeAssessmentDecisionFromHost(actor, input)).toEqual({
    version: 'v1',
    view: null,
    readsAvailable: false,
    unavailableReason: 'DISABLED',
  });
});
