/**
 * Catalog of every boolean switch the repository reads from the environment (`.env.example` is the
 * documented source; `tests/config-validation-boundary.test.ts` fails when the two drift).
 *
 * `HIGH` switches decide money movement, real collection, test modes, identity folding or a default-on
 * behaviour; a mistyped value is refused at startup. `ROUTINE` switches gate dormant features whose own
 * code already treats any value other than exact `true` as off; a mistyped value only warns.
 * Every switch is off by default except `X_TRACKING_V2_ENABLED`, which the code treats as on unless it is
 * exactly `false` (a documented legacy default, pinned to `false` on staging).
 */
export type FlagImpact = 'HIGH' | 'ROUTINE';
export interface FlagDefinition {
  readonly name: string;
  readonly impact: FlagImpact;
  readonly defaultState: 'OFF' | 'ON';
  /** Setting that must be non-blank for the flag to open anything; absence warns (the code stays closed). */
  readonly requires?: string;
}

const high = (name: string, defaultState: 'OFF' | 'ON' = 'OFF'): FlagDefinition =>
  Object.freeze({ name, impact: 'HIGH', defaultState });
const routine = (name: string, requires?: string): FlagDefinition =>
  Object.freeze({
    name,
    impact: 'ROUTINE',
    defaultState: 'OFF',
    ...(requires ? { requires } : {}),
  });

export const FLAG_CATALOG: readonly FlagDefinition[] = Object.freeze([
  high('DEMO_MODE'),
  high('LIVE_COLLECTION_APPROVED'),
  high('LAUNCH_ENABLED'),
  high('PAYOUT_ENABLED'),
  high('X_TRACKING_V2_SETTLEMENT_ENABLED'),
  high('X_TRACKING_V2_ENABLED', 'ON'),
  high('ACCOUNT_FOLDS_ENABLED'),
  high('WALLET_LINKS_ENABLED'),
  high('STUDIO_SANDBOX'),
  high('ALLOW_REMOTE_TEST_DB'),
  routine('RAIDER_ONBOARDING_ENABLED'),
  routine('GUILD_DRAFTS_ENABLED'),
  routine('GUILD_PROJECT_PROPOSALS_ENABLED'),
  routine('SKILL_CLAIMS_ENABLED', 'SKILL_TAXONOMY_ID'),
  routine('SKILL_TAXONOMY_PUBLICATION_ENABLED'),
  routine('PRACTICE_TRIAL_PUBLICATION_ENABLED'),
  routine('PRACTICE_TRIAL_ATTEMPTS_ENABLED'),
  routine('PRACTICE_TRIAL_SUBMISSIONS_ENABLED'),
  routine('SKILL_ASSESSMENT_READS_ENABLED', 'PRACTICE_ASSESSMENT_CATALOG_ID'),
  routine('PRACTICE_ASSESSMENT_DECISIONS_ENABLED'),
  routine('PRACTICE_TRIAL_ASSESSMENTS_ENABLED'),
  routine('PRACTICE_TRIAL_OWNERSHIP_ENABLED'),
  routine('PRACTICE_PORTAL_READS_ENABLED', 'PRACTICE_TRIAL_CATALOG_ID'),
  routine('PRACTICE_REVIEW_ASSIGNMENTS_ENABLED'),
  routine('PRACTICE_REVIEW_POLICY_PUBLICATION_ENABLED'),
  routine('PRACTICE_REVIEW_READS_ENABLED'),
  routine('WORK_WORKSPACE_READS_ENABLED'),
  routine('WORK_FEED_READS_ENABLED'),
  routine('WORK_FEED_ELIGIBILITY_ENABLED', 'WORK_ACCEPTANCE_TAXONOMY_ID'),
  routine('WORK_FEED_REWARD_FILTER_ENABLED'),
  routine('GUILD_PUBLIC_READS_ENABLED'),
  routine('GUILD_UPDATES_ENABLED'),
  routine('GUILD_PROFILE_EDITS_ENABLED'),
  routine('GUILD_ROLE_MANAGEMENT_ENABLED'),
  routine('GUILD_ACTIVATION_ENABLED', 'GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS'),
  routine('PARTY_ROSTER_WRITES_ENABLED'),
  routine('WORK_METRICS_READS_ENABLED'),
  routine('PRODUCT_METRICS_READS_ENABLED'),
  routine('WORK_SUBMISSIONS_ENABLED'),
  routine('WORK_ACCEPTANCE_ENABLED', 'WORK_ACCEPTANCE_TAXONOMY_ID'),
  routine('WORK_START_ENABLED'),
  routine('WORK_REVIEWS_ENABLED'),
  routine('WORK_APPLICATIONS_ENABLED'),
  routine('WORK_ADMISSION_MANAGEMENT_ENABLED'),
  routine('WORK_CLOSURE_ENABLED'),
  routine('WORK_AMENDMENTS_ENABLED'),
  routine('WORK_CREATION_READS_ENABLED'),
  routine('WORK_CREATION_SAVE_ENABLED'),
  routine('WORK_CREATION_PUBLISH_ENABLED'),
  routine('WORK_RECOMMENDATIONS_ENABLED'),
  routine('NOTIFICATIONS_READS_ENABLED'),
  routine('NOTIFICATIONS_DISPATCH_ENABLED'),
]);
