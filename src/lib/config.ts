// Read the canonical origin at server runtime, including when a build moves between environments.
export const config = {
  demo: Reflect.get(process.env, 'DEMO_MODE') === 'true',
  appUrl:
    Reflect.get(process.env, 'NEXT_PUBLIC_APP_URL') ||
    process.env.APP_URL ||
    'http://localhost:3000',
  handle: process.env.X_OFFICIAL_HANDLE || 'useRAID',
  liveApproved: Reflect.get(process.env, 'LIVE_COLLECTION_APPROVED') === 'true',
  retentionDays: Math.max(1, Number(process.env.X_RETENTION_DAYS || 30)),
  refreshMinutes: Math.max(5, Number(process.env.X_REFRESH_MINUTES || 30)),
  searchQueryMaxChars: Math.max(64, Number(process.env.X_SEARCH_QUERY_MAX_CHARS || 512)),
};

/** Server-side switch for creating additional sign-in wallets (T006 B2). Existing credential resolution is independent. Off unless exactly 'true'. */
export const walletLinksEnabled = () => process.env.WALLET_LINKS_ENABLED === 'true';
/** T024 root composition: operator closure route and worker pass. Off unless exactly 'true'; simulated funds only. */
export const workClosureEnabled = () => process.env.WORK_CLOSURE_ENABLED === 'true';
export const trackingEnabled = () => process.env.X_TRACKING_V2_ENABLED !== 'false';
// Automatic folding of an activity-free duplicate account (X callback, wallet link) is off unless
// exactly "true". Its lock order is unsafe under concurrency (deadlocks and stale merges were
// reproduced); keep it off until that protocol is fixed. Duplicates are refused instead.
export const accountFoldsEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.ACCOUNT_FOLDS_ENABLED === 'true';
export const trackingSettlementEnabled = () =>
  trackingEnabled() && process.env.X_TRACKING_V2_SETTLEMENT_ENABLED === 'true';
export const newTrackingRules = () =>
  trackingEnabled()
    ? { trackingVersion: 2, ruleVersion: 3, scoringVersion: 3, officialHandle: config.handle }
    : {};

export const authorCapBps = () => {
  const value = Number(process.env.RAID_AUTHOR_CAP_BPS || 2500);
  return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : 2500;
};
export const solMinPayout = () => {
  const value = process.env.SOL_MIN_PAYOUT_LAMPORTS || '890880';
  return /^\d{1,15}$/.test(value) ? BigInt(value) : 890_880n;
};
export const studioLookupsPerDay = () => {
  const value = Number(process.env.STUDIO_LOOKUPS_PER_DAY || 300);
  return Number.isInteger(value) && value >= 1 ? value : 300;
};
