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
/** Server environment for the owned preview: every flag explicit, nothing live. */
export function workCreationBrowserEnvironment(): Record<string, string> {
  return {
    DEMO_MODE: 'false',
    ADMIN_X_IDS: '',
    X_ADMIN_USER_ID: '',
    USDC_NETWORK: 'devnet',
    WORK_CREATION_READS_ENABLED: 'true',
    WORK_CREATION_SAVE_ENABLED: 'true',
    WORK_CREATION_PUBLISH_ENABLED: 'true',
    WORK_RECOMMENDATIONS_ENABLED: 'true',
    RAID_WORK_OPERATOR_ACCOUNT_IDS: 'founder-synthetic',
    RAID_WORK_GUILD_ID: 'synthetic-guild',
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
  const [{ db }, { hash }, { assertTestDatabase, truncateAll }] = await Promise.all([
    import('../../src/lib/db'),
    import('../../src/lib/auth-primitives'),
    import('./db-guard'),
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
  return {
    db,
    founder: await human('founder-synthetic'),
    stranger: await human('synthetic-stranger'),
  };
}
