import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy } from '../src/skills/taxonomy-storage';
import { hash } from '../src/lib/auth-primitives';
import { WorkError } from '../src/work-loop/contracts';
import { publishDraftFromHost, saveDraftFromHost } from '../src/lib/work-creation-host';
import { raidTerms } from './helpers/raid-terms-fixture';
import { publishAssessmentPolicy } from './helpers/assessment-policy-fixture';
import { rewardAssets } from './helpers/work-creation-fixture';
import { seedWorkHuman } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

// T016 publication check against the Root's real published skill taxonomy and assessment policies (what acceptance reads).
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const TAXONOMY = 'synthetic-work-skill-catalog';
const skills = [
  { id: 'writing', domain: 'content', name: 'Writing', status: 'ACTIVE', aliases: ['writing'] },
  { id: 'legacy', domain: 'content', name: 'Legacy', status: 'RETIRED', aliases: ['legacy'] },
  { id: 'design', domain: 'visual', name: 'Design', status: 'ACTIVE', aliases: ['design'] },
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
  const actor = { accountId: publisher.id, sessionHash };
  await runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor,
        input: { taxonomyId: TAXONOMY, expectedRevision: 0, skills },
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
  return actor;
}
const policyFor = (
  publisher: Awaited<ReturnType<typeof publishTaxonomy>>,
  skillId = 'writing',
  skillDomain = 'content',
  purpose?: 'OWNERSHIP_REVIEW',
) =>
  publishAssessmentPolicy(db, publisher, { taxonomyId: TAXONOMY, skillId, skillDomain }, purpose);
let founder: Awaited<ReturnType<typeof seedWorkHuman>>;
const command = (input: unknown) => ({
  actor: founder.actor,
  input,
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
});
const skill = (skillId: string, assessmentPolicyVersion: string) => ({
  skillId,
  minimumRank: 'E' as const,
  assessmentPolicyVersion,
});
async function draftWith(skillId: string, assessmentPolicyVersion: string) {
  const saved = await saveDraftFromHost(
    command({
      listingId: null,
      expectedRevision: 0,
      terms: { ...raidTerms(), requiredSkills: [skill(skillId, assessmentPolicyVersion)] },
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

  it('publishes a Raid whose skills are active in the published taxonomy and whose policy is published', async () => {
    const publisher = await publishTaxonomy();
    const { policyVersionId } = await policyFor(publisher);
    const draft = await draftWith('writing', policyVersionId);
    expect(draft.problems).not.toContain('SKILL_NOT_RECOGNISED');
    expect(draft.problems).not.toContain('ASSESSMENT_POLICY_NOT_PUBLISHED');
    await expect(publishDraft(draft)).resolves.toMatchObject({ fundingMode: 'SIMULATED' });
    expect(await slots()).toHaveLength(1);
  });

  it.each(['no-such-skill', 'legacy'])(
    'blocks a Raid that requires %s and shows the Founder why',
    async (skillId) => {
      const publisher = await publishTaxonomy();
      const { policyVersionId } = await policyFor(publisher);
      const draft = await draftWith(skillId, policyVersionId);
      expect(draft.problems).toContain('SKILL_NOT_RECOGNISED');
      await expect(publishDraft(draft)).rejects.toMatchObject({ code: 'PUBLICATION_BLOCKED' });
      expect(await slots()).toHaveLength(0);
    },
  );

  it.each([
    ['a label that names no policy', async () => 'starter-v1'],
    ['an id that is not a policy version', async () => randomUUID()],
    [
      'the approved policy of a different skill',
      async (p: Awaited<ReturnType<typeof publishTaxonomy>>) =>
        (await policyFor(p, 'design', 'visual')).policyVersionId,
    ],
    [
      'a policy for ownership review, not assessment',
      async (p: Awaited<ReturnType<typeof publishTaxonomy>>) =>
        (await policyFor(p, 'writing', 'content', 'OWNERSHIP_REVIEW')).policyVersionId,
    ],
    [
      'a withdrawn policy',
      async (p: Awaited<ReturnType<typeof publishTaxonomy>>) => {
        const made = await policyFor(p);
        return (await made.withdraw()).policy.id;
      },
    ],
  ])('blocks a Raid naming %s and shows the Founder why', async (_label, makePolicy) => {
    const publisher = await publishTaxonomy();
    const draft = await draftWith('writing', await makePolicy(publisher));
    expect(draft.problems).toContain('ASSESSMENT_POLICY_NOT_PUBLISHED');
    expect(draft.problems).not.toContain('SKILL_NOT_RECOGNISED');
    await expect(publishDraft(draft)).rejects.toMatchObject({ code: 'PUBLICATION_BLOCKED' });
    expect(await slots()).toHaveLength(0);
  });

  it('blocks a Raid naming a policy that a newer approved revision superseded', async () => {
    const publisher = await publishTaxonomy();
    const made = await policyFor(publisher);
    await made.revise();
    const draft = await draftWith('writing', made.policyVersionId);
    expect(draft.problems).toContain('ASSESSMENT_POLICY_NOT_PUBLISHED');
    await expect(publishDraft(draft)).rejects.toMatchObject({ code: 'PUBLICATION_BLOCKED' });
  });

  it('fails closed when no taxonomy is configured or the configured one is not published', async () => {
    const publisher = await publishTaxonomy();
    const { policyVersionId } = await policyFor(publisher);
    const draft = await draftWith('writing', policyVersionId);
    for (const id of ['', 'synthetic-unpublished-taxonomy']) {
      vi.stubEnv('WORK_ACCEPTANCE_TAXONOMY_ID', id);
      await expect(publishDraft(draft)).rejects.toBeInstanceOf(WorkError);
      expect(await slots()).toHaveLength(0);
    }
  });
});
