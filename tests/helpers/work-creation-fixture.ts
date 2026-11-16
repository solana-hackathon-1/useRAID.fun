import { randomUUID } from 'node:crypto';
import { exampleRubric } from '../../examples/raid-terms/recommendation-fixture';
import { raidTerms } from './raid-terms-fixture';

/** Synthetic reward assets: SOL is covered by the simulated reserve, the token deliberately is not. */
export const rewardAssets = () => {
  const sol = raidTerms().rewards[0].policy;
  return [
    { label: 'Synthetic SOL', policy: sol, funded: true },
    {
      label: 'Synthetic token',
      policy: {
        ...sol,
        assetId: {
          chain: 'SOLANA',
          networkIdentity: 'synthetic-work',
          kind: 'TOKEN',
          mint: '11111111111111111111111111111111',
          tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
        verifiedDecimals: 6,
      },
      funded: false,
    },
  ];
};
export const WORK_CREATION_TAXONOMY_ID = 'synthetic-work-creation-catalog';
/** Server environment for the owned preview: every flag explicit, nothing live. */
export function workCreationBrowserEnvironment(): Record<string, string> {
  return {
    DEMO_MODE: 'false',
    // Declared non-production (DEC-2026-11-13-15): the production build otherwise restricts the catalog to Guild
    // Founder/WORK authority, which this synthetic fixture (operator allowlist, no stored Guild) does not model.
    // That restriction is proven against real Guild grants in tests/work-creation-catalog-db.test.ts.
    RAID_ENVIRONMENT: 'alpha',
    ADMIN_X_IDS: '',
    X_ADMIN_USER_ID: '',
    USDC_NETWORK: 'devnet',
    WORK_CREATION_READS_ENABLED: 'true',
    WORK_CREATION_SAVE_ENABLED: 'true',
    WORK_CREATION_PUBLISH_ENABLED: 'true',
    WORK_RECOMMENDATIONS_ENABLED: 'true',
    RAID_WORK_OPERATOR_ACCOUNT_IDS: 'founder-synthetic',
    RAID_WORK_GUILD_ID: 'synthetic-guild',
    // Publication names only skills of this published taxonomy (seeded below), as acceptance reads it.
    WORK_ACCEPTANCE_TAXONOMY_ID: WORK_CREATION_TAXONOMY_ID,
    WORK_REWARD_ASSETS_JSON: JSON.stringify(rewardAssets()),
    WORK_RECOMMENDATION_RUBRIC_JSON: JSON.stringify(exampleRubric()),
    WORK_WORKSPACE_READS_ENABLED: 'false',
    PRACTICE_PORTAL_READS_ENABLED: 'false',
    SKILL_ASSESSMENT_READS_ENABLED: 'false',
    SKILL_CLAIMS_ENABLED: 'false',
    RAIDER_ONBOARDING_ENABLED: 'false',
    ACCOUNT_FOLDS_ENABLED: 'false',
    WALLET_LINKS_ENABLED: 'false',
    LIVE_COLLECTION_APPROVED: 'false',
    LAUNCH_ENABLED: 'false',
    PAYOUT_ENABLED: 'false',
    X_TRACKING_V2_SETTLEMENT_ENABLED: 'false',
  };
}
/** Resets the synthetic database and creates the operator Founder and a non-operator stranger, each with a session. */
export async function seedWorkCreationFixture() {
  const [{ db }, { hash }, { assertTestDatabase, truncateAll }, taxonomy, receipts] =
    await Promise.all([
      import('../../src/lib/db'),
      import('../../src/lib/auth-primitives'),
      import('./db-guard'),
      import('../../src/skills/taxonomy-storage'),
      import('../../src/lib/command-receipts-adapter'),
    ]);
  assertTestDatabase();
  await truncateAll(db);
  async function human(id: string) {
    const user = await db.user.create({ data: { id, handle: id, role: 'CREATOR' } });
    await db.participant.create({
      data: {
        accountId: user.id,
        provisionActorAccountId: user.id,
        provisionRequestId: 'synthetic-' + id,
      },
    });
    const cookie = randomUUID();
    await db.session.create({
      data: {
        tokenHash: hash(cookie),
        userId: user.id,
        via: 'wallet',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return { id, cookie };
  }
  // The published skill taxonomy that Raid publication checks required skills against.
  const publisher = await db.user.create({
    data: { handle: 'catalog-publisher-synthetic', role: 'ADMIN', xId: randomUUID() },
  });
  const publisherSession = hash(randomUUID());
  await db.session.create({
    data: {
      tokenHash: publisherSession,
      userId: publisher.id,
      via: 'x',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  await receipts.runCommandTransaction(db, (tx) =>
    taxonomy.publishSkillTaxonomy(
      tx,
      {
        actor: { accountId: publisher.id, sessionHash: publisherSession },
        input: {
          taxonomyId: WORK_CREATION_TAXONOMY_ID,
          expectedRevision: 0,
          skills: [
            {
              id: 'writing',
              domain: 'content',
              name: 'Writing',
              status: 'ACTIVE',
              aliases: ['writing'],
            },
          ],
        },
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
  // The approved assessment policy the Raid names (acceptance matches a verified assessment to this exact version).
  const { publishAssessmentPolicy } = await import('./assessment-policy-fixture');
  const { policyVersionId } = await publishAssessmentPolicy(
    db,
    { accountId: publisher.id, sessionHash: publisherSession },
    { taxonomyId: WORK_CREATION_TAXONOMY_ID, skillId: 'writing', skillDomain: 'content' },
  );
  return {
    db,
    policyVersionId,
    founder: await human('founder-synthetic'),
    stranger: await human('synthetic-stranger'),
  };
}
