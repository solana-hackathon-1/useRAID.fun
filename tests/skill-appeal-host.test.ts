import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  file: vi.fn(),
  adjudicate: vi.fn(),
  user: vi.fn(),
  rate: vi.fn(),
  cookie: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../src/lib/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/auth')>()),
  requireUser: mocks.user,
  rateLimit: mocks.rate,
}));
vi.mock('../src/lib/command-receipts-adapter', () => ({ runCommandTransaction: mocks.run }));
vi.mock('../src/skill-appeals/storage', async (original) => ({
  ...(await original<typeof import('../src/skill-appeals/storage')>()),
  fileSkillAssessmentAppeal: mocks.file,
  adjudicateSkillAssessmentAppeal: mocks.adjudicate,
}));
import {
  adjudicateSkillAppealFromHost,
  fileSkillAppealFromHost,
  skillAppealAdjudicators,
  skillAppealConfiguration,
  skillAppealWindows,
} from '../src/lib/skill-appeals-host';
import { POST as fileRoute } from '../src/app/api/v1/skill-assessment-appeals/route';
import { POST as decideRoute } from '../src/app/api/v1/skill-assessment-appeals/[appealId]/decision/route';
import { config } from '../src/lib/config';
import { hash, HttpError } from '../src/lib/auth-primitives';
import { routeRequest } from './helpers/route';

const actor = { accountId: 'synthetic-adjudicator', sessionHash: 'a'.repeat(64) };
const command = { actor, input: {}, idempotencyKey: 'key', requestId: 'r' };
const origin = 'http://localhost:3014';
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  config.appUrl = origin;
  config.demo = false;
  mocks.run.mockImplementation((_db, work) => work({}));
  mocks.user.mockResolvedValue({ id: 'synthetic-adjudicator' });
  mocks.cookie.mockReturnValue({ value: 'synthetic-cookie' });
  mocks.rate.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

it('is off unless the exact string true, and passes the switch as allowNewWrites', async () => {
  expect(skillAppealConfiguration()).toEqual({
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  for (const flag of ['', 'false', 'TRUE', '1', ' true']) {
    vi.stubEnv('SKILL_ASSESSMENT_APPEALS_ENABLED', flag);
    expect(skillAppealConfiguration().writesAvailable).toBe(false);
  }
  await fileSkillAppealFromHost(command);
  expect(mocks.file.mock.calls[0][2]).toMatchObject({ allowNewWrites: false });
  vi.stubEnv('SKILL_ASSESSMENT_APPEALS_ENABLED', 'true');
  await adjudicateSkillAppealFromHost(command);
  expect(mocks.adjudicate.mock.calls[0][2]).toMatchObject({ allowNewWrites: true });
});
it('reads the dedicated allowlist exactly and on every call, empty denying everyone', async () => {
  const ask = async (accountId: string) => {
    await adjudicateSkillAppealFromHost(command);
    return mocks.adjudicate.mock.calls.at(-1)![2].isAdjudicator(accountId) as boolean;
  };
  expect(await ask('a')).toBe(false);
  vi.stubEnv('SKILL_APPEAL_REVIEWER_ACCOUNT_IDS', ' a , b ,,');
  expect([...skillAppealAdjudicators()]).toEqual(['a', 'b']);
  expect(await ask('a')).toBe(true);
  expect(await ask('A')).toBe(false);
  expect(await ask('c')).toBe(false);
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', 'c');
  vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', 'c');
  expect(await ask('c')).toBe(false);
  vi.stubEnv('SKILL_APPEAL_REVIEWER_ACCOUNT_IDS', 'b');
  expect(await ask('a')).toBe(false);
});
it('defaults both provisional windows to 14 days and never falls to zero or unlimited', async () => {
  const fourteen = { filingWindowSeconds: 14 * 86400, adjudicationSeconds: 14 * 86400 };
  expect(skillAppealWindows()).toEqual(fourteen);
  for (const bad of ['0', '-3', '1.5', 'abc', '366', '999999', '']) {
    vi.stubEnv('SKILL_APPEAL_FILING_WINDOW_DAYS', bad);
    vi.stubEnv('SKILL_APPEAL_ADJUDICATION_DAYS', bad);
    expect(skillAppealWindows()).toEqual(fourteen);
  }
  vi.stubEnv('SKILL_APPEAL_FILING_WINDOW_DAYS', '30');
  vi.stubEnv('SKILL_APPEAL_ADJUDICATION_DAYS', '7');
  expect(skillAppealWindows()).toEqual({
    filingWindowSeconds: 30 * 86400,
    adjudicationSeconds: 7 * 86400,
  });
  await fileSkillAppealFromHost(command);
  expect(mocks.file.mock.calls[0][2]).toMatchObject({
    filingWindowSeconds: 30 * 86400,
    adjudicationSeconds: 7 * 86400,
  });
});
it('derives the actor only from the own server cookie and denies missing session or foreign origin first', async () => {
  const body = {
    version: 'v1',
    expectedAssessmentReference: { recordId: 'synthetic-assessment', revision: 1 },
    reasonCategory: 'FACTUAL_ERROR',
    statement: 'Synthetic statement.',
  };
  const send = (from = origin) =>
    routeRequest(origin + '/api/v1/skill-assessment-appeals', {
      body,
      origin: from,
      headers: { 'Idempotency-Key': 'k-1' },
    });
  mocks.user.mockRejectedValue(new HttpError(401, 'Sign in'));
  expect((await fileRoute(send())).status).toBe(401);
  mocks.user.mockResolvedValue({ id: 'synthetic-adjudicator' });
  mocks.cookie.mockReturnValue(undefined);
  expect((await fileRoute(send())).status).toBe(401);
  mocks.cookie.mockReturnValue({ value: 'synthetic-cookie' });
  expect((await fileRoute(send('https://evil.example'))).status).toBe(403);
  expect(mocks.file).not.toHaveBeenCalled();
  mocks.user.mockResolvedValue({ id: 'synthetic-adjudicator' });
  await fileRoute(send());
  expect(mocks.rate).toHaveBeenLastCalledWith('skill-appeal-file:synthetic-adjudicator', 20, 60);
  expect(mocks.file.mock.calls.at(-1)![1]).toMatchObject({
    actor: { accountId: 'synthetic-adjudicator', sessionHash: hash('synthetic-cookie') },
    idempotencyKey: 'k-1',
  });
});
it('routes a decision with the path appeal id', async () => {
  const id = '44444444-4444-4444-8444-444444444444';
  mocks.adjudicate.mockResolvedValue({ status: 'EXECUTED' });
  const res = await decideRoute(
    routeRequest(origin + '/api/v1/skill-assessment-appeals/' + id + '/decision', {
      body: { version: 'v1', outcome: 'DENIED', reason: 'Synthetic reason.' },
      origin,
      headers: { 'Idempotency-Key': 'k-2' },
    }),
    { params: Promise.resolve({ appealId: id }) },
  );
  expect(mocks.rate).toHaveBeenLastCalledWith('skill-appeal-decide:synthetic-adjudicator', 20, 60);
  expect(res.status).toBe(503); // the mocked storage result is not a valid appeal view
  expect(mocks.adjudicate.mock.calls[0][1].input).toEqual({
    version: 'v1',
    appealId: id,
    outcome: 'DENIED',
    reason: 'Synthetic reason.',
  });
});
