import { afterEach, expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({
  tx: {},
  my: vi.fn(),
  queue: vi.fn(),
  applicants: vi.fn(),
  submit: vi.fn(),
  decide: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
  withdraw: vi.fn(),
  apply: vi.fn(),
  consent: vi.fn(),
  commit: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/work-loop/workspace-storage', () => ({
  readMyRaids: port.my,
  readReviewQueue: port.queue,
  readApplicantQueue: port.applicants,
}));
vi.mock('../src/work-loop/submission-storage', () => ({
  submitWork: port.submit,
  decideReview: port.decide,
}));
vi.mock('../src/work-loop/consent-storage', () => ({ recordAcceptanceConsent: port.consent }));
vi.mock('../src/work-loop/engagement-storage', () => ({ commitEngagement: port.commit }));
vi.mock('../src/work-loop/admission-storage', () => ({
  issueOffer: port.issue,
  revokeOffer: port.revoke,
  withdrawApplication: port.withdraw,
  submitApplication: port.apply,
}));
import {
  workWorkspaceConfiguration,
  readMyRaidsFromHost,
  readApplicantQueueFromHost,
  submitWorkFromHost,
  decideReviewFromHost,
  issueOfferFromHost,
  withdrawApplicationFromHost,
  submitApplicationFromHost,
  recordConsentFromHost,
  commitEngagementFromHost,
} from '../src/lib/work-workspace-host';
const actor = { accountId: 'member', sessionHash: 'a'.repeat(64) };
const command = { actor, input: {}, idempotencyKey: 'key-1', requestId: 'req-1' };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults every workspace flag off and requires the exact string true', () => {
  for (const value of [undefined, '', 'TRUE', 'false', '1'])
    for (const name of [
      'WORK_WORKSPACE_READS_ENABLED',
      'WORK_SUBMISSIONS_ENABLED',
      'WORK_REVIEWS_ENABLED',
      'WORK_APPLICATIONS_ENABLED',
      'WORK_ACCEPTANCE_ENABLED',
      'WORK_ADMISSION_MANAGEMENT_ENABLED',
    ])
      vi.stubEnv(name, value);
  expect(workWorkspaceConfiguration()).toEqual({
    readsAvailable: false,
    submissionsAvailable: false,
    reviewsAvailable: false,
    applicationsAvailable: false,
    acceptanceAvailable: false,
    offersAvailable: false,
  });
});
it('keeps every read and write closed until reads are enabled', async () => {
  for (const call of [
    () => readMyRaidsFromHost(actor),
    () => submitWorkFromHost(command),
    () => decideReviewFromHost(command),
    () => issueOfferFromHost(command),
    () => withdrawApplicationFromHost(command),
    () => submitApplicationFromHost(command),
    () => recordConsentFromHost(command),
    () => commitEngagementFromHost(command),
  ])
    await expect(call()).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  expect(port.my).not.toHaveBeenCalled();
  expect(port.submit).not.toHaveBeenCalled();
});
it('lets each write flag control only new writes of its own command', async () => {
  vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
  port.submit.mockResolvedValue('submitted');
  port.decide.mockResolvedValue('decided');
  await submitWorkFromHost(command);
  expect(port.submit).toHaveBeenLastCalledWith(port.tx, command, { allowNewWrites: false });
  vi.stubEnv('WORK_SUBMISSIONS_ENABLED', 'true');
  await submitWorkFromHost(command);
  expect(port.submit).toHaveBeenLastCalledWith(port.tx, command, { allowNewWrites: true });
  await decideReviewFromHost(command);
  expect(port.decide).toHaveBeenLastCalledWith(port.tx, command, { allowNewWrites: false });
});
it('grants listing authority only to the explicit synthetic operator allowlist', async () => {
  vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
  port.applicants.mockResolvedValue({ listings: [] });
  const authorize = async () => {
    await readApplicantQueueFromHost(actor);
    const host = port.applicants.mock.calls.at(-1)![2];
    return host.authorize(port.tx, actor, 'guild', 'MANAGE_LISTING');
  };
  expect(await authorize()).toBe(false);
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', ' other , ,member ');
  expect(await authorize()).toBe(true);
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', 'other');
  expect(await authorize()).toBe(false);
});
it('bounds the configured application limit and falls back to the fixture of five', async () => {
  vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
  port.issue.mockResolvedValue('issued');
  const limit = async () => {
    await issueOfferFromHost(command);
    return port.issue.mock.calls.at(-1)![2].applicationLimit;
  };
  expect(await limit()).toBe(5);
  for (const [value, expected] of [
    ['3', 3],
    ['0', 5],
    ['101', 5],
    ['x', 5],
    ['2.5', 5],
  ] as const) {
    vi.stubEnv('WORK_APPLICATION_LIMIT', value);
    expect(await limit()).toBe(expected);
  }
});
it('opens new applications only with the applications flag and the explicit limit', async () => {
  vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
  port.apply.mockResolvedValue('applied');
  await submitApplicationFromHost(command);
  expect(port.apply.mock.calls.at(-1)![2]).toMatchObject({
    allowNewWrites: false,
    applicationLimit: 5,
  });
  vi.stubEnv('WORK_APPLICATIONS_ENABLED', 'true');
  vi.stubEnv('WORK_APPLICATION_LIMIT', '3');
  await submitApplicationFromHost(command);
  expect(port.apply.mock.calls.at(-1)![2]).toMatchObject({
    allowNewWrites: true,
    applicationLimit: 3,
  });
});
it('opens acceptance only with the flag and a configured taxonomy, and hands the commit a real Root host', async () => {
  vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
  port.consent.mockResolvedValue('consented');
  port.commit.mockResolvedValue('committed');
  vi.stubEnv('WORK_ACCEPTANCE_ENABLED', 'true');
  expect(workWorkspaceConfiguration().acceptanceAvailable).toBe(false);
  await recordConsentFromHost(command);
  expect(port.consent.mock.calls.at(-1)![2]).toEqual({ allowNewWrites: false });
  vi.stubEnv('WORK_ACCEPTANCE_TAXONOMY_ID', 'catalog-1');
  expect(workWorkspaceConfiguration().acceptanceAvailable).toBe(true);
  await recordConsentFromHost(command);
  expect(port.consent.mock.calls.at(-1)![2]).toEqual({ allowNewWrites: true });
  await commitEngagementFromHost(command);
  const host = port.commit.mock.calls.at(-1)![2];
  expect(host.allowNewWrites).toBe(true);
  for (const fn of ['assess', 'fundingAvailable', 'authorizeOfferIssuer'])
    expect(typeof host[fn]).toBe('function');
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', 'issuer-1');
  expect(await host.authorizeOfferIssuer(port.tx, { accountId: 'issuer-1' })).toBe(true);
  expect(await host.authorizeOfferIssuer(port.tx, { accountId: 'someone' })).toBe(false);
});
