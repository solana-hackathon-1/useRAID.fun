import { afterEach, expect, it, vi } from 'vitest';
import { exampleRubric } from '../examples/raid-terms/recommendation-fixture';
import { rewardAssets } from './helpers/work-creation-fixture';
import { raidTerms } from './helpers/raid-terms-fixture';

const port = vi.hoisted(() => ({
  tx: {},
  drafts: vi.fn(),
  save: vi.fn(),
  publish: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/work-loop/creation-storage', () => ({ readCreationDrafts: port.drafts }));
vi.mock('../src/work-loop/storage', () => ({
  saveRaidTerms: port.save,
  publishRaid: port.publish,
}));
import {
  creationStateFromHost,
  publishDraftFromHost,
  recommendFromHost,
  rewardCatalog,
  saveDraftFromHost,
  workCreationConfiguration,
} from '../src/lib/work-creation-host';

const actor = { accountId: 'founder-1', sessionHash: 'a'.repeat(64) };
const ENV = [
  'WORK_CREATION_READS_ENABLED',
  'WORK_CREATION_SAVE_ENABLED',
  'WORK_CREATION_PUBLISH_ENABLED',
  'WORK_RECOMMENDATIONS_ENABLED',
  'RAID_WORK_OPERATOR_ACCOUNT_IDS',
  'RAID_WORK_GUILD_ID',
  'WORK_REWARD_ASSETS_JSON',
  'WORK_RECOMMENDATION_RUBRIC_JSON',
];
afterEach(() => {
  for (const name of ENV) delete process.env[name];
  vi.clearAllMocks();
});
it('is off by default and only exact "true" enables a flag', () => {
  expect(workCreationConfiguration()).toEqual({
    readsAvailable: false,
    savesAvailable: false,
    publishAvailable: false,
    recommendationsAvailable: false,
  });
  process.env.WORK_CREATION_READS_ENABLED = 'TRUE';
  process.env.WORK_CREATION_SAVE_ENABLED = '1';
  expect(workCreationConfiguration().readsAvailable).toBe(false);
  expect(workCreationConfiguration().savesAvailable).toBe(false);
  process.env.WORK_CREATION_READS_ENABLED = 'true';
  expect(workCreationConfiguration().readsAvailable).toBe(true);
});
it('refuses every operation until reads are enabled, even replay-shaped saves', async () => {
  await expect(creationStateFromHost(actor)).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  await expect(
    saveDraftFromHost({ actor, input: {}, idempotencyKey: 'k', requestId: 'r' }),
  ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  await expect(
    publishDraftFromHost({ actor, input: {}, idempotencyKey: 'k', requestId: 'r' }),
  ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  expect(port.save).not.toHaveBeenCalled();
  expect(port.publish).not.toHaveBeenCalled();
});
it('treats a missing or malformed reward catalog as nothing to offer, never as permission', () => {
  expect(rewardCatalog()).toEqual([]);
  process.env.WORK_REWARD_ASSETS_JSON = 'not json';
  expect(rewardCatalog()).toEqual([]);
  process.env.WORK_REWARD_ASSETS_JSON = JSON.stringify([{ label: 'x', funded: true }]);
  expect(rewardCatalog()).toEqual([]);
  process.env.WORK_REWARD_ASSETS_JSON = JSON.stringify(rewardAssets());
  expect(rewardCatalog().map((a) => [a.label, a.funded])).toEqual([
    ['Synthetic SOL', true],
    ['Synthetic token', false],
  ]);
});
it('fails closed on an ambiguous catalog that lists one asset twice', () => {
  const [sol] = rewardAssets();
  process.env.WORK_REWARD_ASSETS_JSON = JSON.stringify([sol, { ...sol, funded: false }]);
  expect(rewardCatalog()).toEqual([]);
});
it('saves with the configured Guild, only for an allowlisted operator, and returns the server-derived draft', async () => {
  process.env.WORK_CREATION_READS_ENABLED = 'true';
  process.env.WORK_CREATION_SAVE_ENABLED = 'true';
  process.env.RAID_WORK_OPERATOR_ACCOUNT_IDS = 'founder-1';
  process.env.RAID_WORK_GUILD_ID = 'guild-9';
  process.env.WORK_REWARD_ASSETS_JSON = JSON.stringify(rewardAssets());
  const draft = {
    listingId: '11111111-1111-4111-8111-111111111111',
    termsVersionId: '33333333-3333-4333-8333-333333333333',
    revision: 1,
    state: 'DRAFT',
    terms: raidTerms(),
    problems: [],
    reserved: false,
  };
  port.save.mockResolvedValue({ status: 'EXECUTED', listingId: draft.listingId });
  port.drafts.mockResolvedValue([draft]);
  const result = await saveDraftFromHost({
    actor,
    input: { listingId: null, expectedRevision: 0, terms: raidTerms() },
    idempotencyKey: 'k',
    requestId: 'r',
  });
  const [, command, host] = port.save.mock.calls[0];
  expect(command.input).toMatchObject({ guildId: 'guild-9' });
  expect(host.allowNewWrites).toBe(true);
  expect(await host.authorize({}, actor, 'guild-9', 'MANAGE_LISTING')).toBe(true);
  expect(
    await host.authorize({}, { ...actor, accountId: 'someone' }, 'guild-9', 'MANAGE_LISTING'),
  ).toBe(false);
  expect(await host.authorize({}, actor, 'another-guild', 'MANAGE_LISTING')).toBe(false);
  expect(result.draft).toMatchObject({ ready: true, review: { coverage: 'ALL_FUNDED' } });
});
it('keeps writes off when the save or publish flag is off while reads and replays stay available', async () => {
  process.env.WORK_CREATION_READS_ENABLED = 'true';
  port.save.mockResolvedValue({ status: 'REPLAYED', listingId: 'x' });
  port.drafts.mockResolvedValue([]);
  await saveDraftFromHost({ actor, input: {}, idempotencyKey: 'k', requestId: 'r' }).catch(
    () => undefined,
  );
  expect(port.save.mock.calls[0][2].allowNewWrites).toBe(false);
  port.publish.mockResolvedValue({});
  await publishDraftFromHost({ actor, input: {}, idempotencyKey: 'k', requestId: 'r' });
  expect(port.publish.mock.calls[0][2].allowNewWrites).toBe(false);
});
it('gives advice only with its flag and a valid rubric, never a default', async () => {
  process.env.WORK_CREATION_READS_ENABLED = 'true';
  const input = {
    outcome: 'x',
    acceptanceCriteria: ['y'],
    skillDomains: [{ skillId: 'writing', role: 'PRIMARY' }],
    integrations: 0,
    dependencies: 0,
    uncertainty: 'LOW',
    consequenceOfError: 'LOW',
    verificationCost: 'LOW',
    deadlinePressure: 'NORMAL',
  };
  await expect(recommendFromHost(actor, input)).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  process.env.WORK_RECOMMENDATIONS_ENABLED = 'true';
  await expect(recommendFromHost(actor, input)).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  process.env.WORK_RECOMMENDATION_RUBRIC_JSON = JSON.stringify(exampleRubric());
  expect(await recommendFromHost(actor, input)).toMatchObject({
    authoritative: false,
    rubricEvaluation: 'UNEVALUATED_EXAMPLE',
  });
  port.drafts.mockResolvedValue([]);
  expect((await creationStateFromHost(actor)).recommendationsAvailable).toBe(true);
});
