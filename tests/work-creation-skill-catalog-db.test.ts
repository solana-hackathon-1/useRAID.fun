import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy } from '../src/skills/taxonomy-storage';
import { hash } from '../src/lib/auth-primitives';
import { WorkError } from '../src/work-loop/contracts';
import { publishDraftFromHost, saveDraftFromHost } from '../src/lib/work-creation-host';
import { raidTerms } from './helpers/raid-terms-fixture';
import { rewardAssets } from './helpers/work-creation-fixture';
import { seedWorkHuman } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

// T016 publication check against the Root's real published skill taxonomy (the one acceptance reads).
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const TAXONOMY = 'synthetic-work-skill-catalog';
const skills = [
  { id: 'writing', domain: 'content', name: 'Writing', status: 'ACTIVE', aliases: ['writing'] },
  { id: 'legacy', domain: 'content', name: 'Legacy', status: 'RETIRED', aliases: ['legacy'] },
];
async function publishTaxonomy() {
  const publisher = await db.user.create({
    data: { handle: 'synthetic-publisher-' + randomUUID(), role: 'ADMIN', xId: randomUUID() },
  });
  const sessionHash = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: sessionHash,
      userId: publisher.id,
      via: 'x',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  await runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor: { accountId: publisher.id, sessionHash },
        input: { taxonomyId: TAXONOMY, expectedRevision: 0, skills },
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
}
let founder: Awaited<ReturnType<typeof seedWorkHuman>>;
const command = (input: unknown) => ({
  actor: founder.actor,
  input,
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
});
const skill = (skillId: string) => ({
  skillId,
  minimumRank: 'E' as const,
  assessmentPolicyVersion: 'starter-v1',
});
async function draftWith(skillId: string) {
  const saved = await saveDraftFromHost(
    command({
      listingId: null,
      expectedRevision: 0,
      terms: { ...raidTerms(), requiredSkills: [skill(skillId)] },
    }),
  );
  return saved.draft;
}
const publishDraft = (draft: { listingId: string; termsVersionId: string }) =>
  publishDraftFromHost(
    command({ listingId: draft.listingId, termsVersionId: draft.termsVersionId }),
  );
const slots = async () => (await db.$queryRawUnsafe('SELECT 1 FROM "RaidSlot"')) as unknown[];

integration('T016 Raid publication names only skills in the published taxonomy', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    founder = await seedWorkHuman(db, 'founder-skill-catalog');
    vi.stubEnv('RAID_ENVIRONMENT', 'alpha');
    vi.stubEnv('WORK_CREATION_READS_ENABLED', 'true');
    vi.stubEnv('WORK_CREATION_SAVE_ENABLED', 'true');
    vi.stubEnv('WORK_CREATION_PUBLISH_ENABLED', 'true');
    vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', founder.actor.accountId);
    vi.stubEnv('RAID_WORK_GUILD_ID', 'synthetic-guild');
    vi.stubEnv('WORK_REWARD_ASSETS_JSON', JSON.stringify(rewardAssets()));
    vi.stubEnv('WORK_ACCEPTANCE_TAXONOMY_ID', TAXONOMY);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => db.$disconnect());

  it('publishes a Raid whose skills are active in the published taxonomy', async () => {
    await publishTaxonomy();
    const draft = await draftWith('writing');
    expect(draft.problems).not.toContain('SKILL_NOT_RECOGNISED');
    await expect(publishDraft(draft)).resolves.toMatchObject({ fundingMode: 'SIMULATED' });
    expect(await slots()).toHaveLength(1);
  });

  it.each(['no-such-skill', 'legacy'])(
    'blocks a Raid that requires %s and shows the Founder why',
    async (skillId) => {
      await publishTaxonomy();
      const draft = await draftWith(skillId);
      expect(draft.problems).toContain('SKILL_NOT_RECOGNISED');
      await expect(publishDraft(draft)).rejects.toMatchObject({ code: 'PUBLICATION_BLOCKED' });
      expect(await slots()).toHaveLength(0);
    },
  );

  it('fails closed when no taxonomy is configured or the configured one is not published', async () => {
    await publishTaxonomy();
    const draft = await draftWith('writing');
    for (const id of ['', 'synthetic-unpublished-taxonomy']) {
      vi.stubEnv('WORK_ACCEPTANCE_TAXONOMY_ID', id);
      await expect(publishDraft(draft)).rejects.toBeInstanceOf(WorkError);
      expect(await slots()).toHaveLength(0);
    }
  });
});
