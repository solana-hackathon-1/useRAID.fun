import { afterEach, expect, it, vi } from 'vitest';
import { exampleRubric } from '../examples/raid-terms/recommendation-fixture';
import { rewardAssets } from './helpers/work-creation-fixture';
import { raidTerms } from './helpers/raid-terms-fixture';

const port = vi.hoisted(() => ({
  tx: {},
  drafts: vi.fn(),
  save: vi.fn(),
  publish: vi.fn(),
  authority: vi.fn(),
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
vi.mock('../src/guild-profiles/guild-storage', () => ({ hasGuildAuthority: port.authority }));
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
  'RAID_ENVIRONMENT',
  'DEMO_MODE',
];
afterEach(() => {
  for (const name of ENV) delete process.env[name];
  vi.unstubAllEnvs();
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

it('reads the exact receipt version instead of searching the latest twenty drafts', async () => {
  process.env.WORK_CREATION_READS_ENABLED = 'true';
  const saved = {
    status: 'REPLAYED',
    listingId: '11111111-1111-4111-8111-111111111111',
    termsVersionId: '33333333-3333-4333-8333-333333333333',
  };
  port.save.mockResolvedValue(saved);
  port.drafts.mockResolvedValue([]);
  await saveDraftFromHost({ actor, input: {}, idempotencyKey: 'old-key', requestId: 'r' }).catch(
    () => undefined,
  );
  expect(port.drafts).toHaveBeenCalledWith(port.tx, actor, expect.anything(), {
    listingId: saved.listingId,
    termsVersionId: saved.termsVersionId,
  });
});

// DEC-2026-11-13-15 (2), #253: in production the catalog is for Founder or live WORK authority only.
const GUILD = '99999999-9999-4999-8999-999999999999';
function catalogHost(environment: Record<string, string>) {
  process.env.WORK_CREATION_READS_ENABLED = 'true';
  process.env.RAID_WORK_GUILD_ID = GUILD;
  process.env.WORK_REWARD_ASSETS_JSON = JSON.stringify(rewardAssets());
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  port.drafts.mockResolvedValue([]);
}
it('serves the catalog in production only to Founder or WORK authority recorded by the Guild host', async () => {
  catalogHost({ RAID_ENVIRONMENT: 'production' });
  port.authority.mockResolvedValue(true);
  const state = await creationStateFromHost(actor);
  expect(state.assets.map((a) => a.label)).toEqual(['Synthetic SOL', 'Synthetic token']);
  expect(port.authority).toHaveBeenCalledWith(port.tx, actor.accountId, GUILD, 'WORK');
});
it('answers a stranger in production with the existing not-found shape and reads nothing else', async () => {
  catalogHost({ RAID_ENVIRONMENT: 'production' });
  port.authority.mockResolvedValue(false);
  await expect(creationStateFromHost(actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(port.drafts).not.toHaveBeenCalled();
});
it('fails closed in production when the authority check errors or answers anything but true', async () => {
  catalogHost({ RAID_ENVIRONMENT: 'production' });
  port.authority.mockRejectedValue(new Error('database down'));
  await expect(creationStateFromHost(actor)).rejects.toThrow();
  for (const answer of [undefined, null, 'true', 1, {}]) {
    port.authority.mockResolvedValue(answer);
    await expect(creationStateFromHost(actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }
  expect(port.drafts).not.toHaveBeenCalled();
});
it('does not let an operator allowlist, a demo flag or a draft stand in for Guild authority in production', async () => {
  catalogHost({ RAID_ENVIRONMENT: ' Production ', DEMO_MODE: 'true' });
  process.env.RAID_WORK_OPERATOR_ACCOUNT_IDS = actor.accountId;
  port.authority.mockResolvedValue(false);
  await expect(creationStateFromHost(actor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('treats an undeclared or unrecognised environment under NODE_ENV=production as production', async () => {
  for (const label of [undefined, '', 'prod', 'live']) {
    catalogHost({
      NODE_ENV: 'production',
      ...(label === undefined ? {} : { RAID_ENVIRONMENT: label }),
    });
    port.authority.mockResolvedValue(false);
    await expect(creationStateFromHost(actor), String(label)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    vi.unstubAllEnvs();
  }
});
it('keeps the synthetic catalog for any signed-in account in declared non-production environments', async () => {
  for (const label of ['staging', 'pilot', 'alpha', 'demo', 'local']) {
    catalogHost({ NODE_ENV: 'production', RAID_ENVIRONMENT: label });
    const state = await creationStateFromHost(actor);
    expect(state.assets).toHaveLength(2);
    vi.unstubAllEnvs();
  }
  catalogHost({});
  expect((await creationStateFromHost(actor)).assets).toHaveLength(2);
  expect(port.authority).not.toHaveBeenCalled();
});
