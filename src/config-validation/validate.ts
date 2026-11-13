import { FLAG_CATALOG } from './flags';

/**
 * Pure runtime-configuration validation (blueprint 29.1/29.2, D12, I12, AC41). The host passes the
 * environment; this module reads no environment, file, clock or network, and a violation names a
 * variable and a code only, never a value. It decides refusal only for combinations that could start a
 * real operation (money, signing, collection) without its authority, expose a signer, or run a test mode in
 * production. Anything the application code already keeps closed (a dormant feature flag, a missing
 * catalog id) only warns. It never enables anything and does not choose a supported asset (O07/G04).
 */
export type ConfigRole = 'web' | 'worker';
export type ViolationSeverity = 'REFUSE' | 'WARN';
export type ViolationCode =
  | 'FLAG_VALUE_NOT_EXACT'
  | 'UNKNOWN_FLAG'
  | 'ENVIRONMENT_NOT_RECOGNISED'
  | 'FLAG_SETTING_MISSING'
  | 'REAL_OPERATION_AUTHORITY_MISSING'
  | 'REAL_OPERATION_IN_DEMO'
  | 'SIGNER_SECRET_ON_WEB'
  | 'TEST_MODE_IN_PRODUCTION'
  | 'DEVNET_OR_DEMO_IN_PRODUCTION'
  | 'TEST_DATABASE_IN_PRODUCTION'
  | 'SAMPLE_OPERATOR_KEY_IN_PRODUCTION'
  | 'SYNTHETIC_WITH_REAL_MONEY'
  | 'ENVIRONMENT_NOT_DECLARED'
  | 'DATABASE_URL_UNPARSEABLE';
export interface ConfigViolation {
  readonly severity: ViolationSeverity;
  readonly code: ViolationCode;
  readonly subject: string;
}
export interface ConfigValidation {
  /** True when no violation refuses; warnings do not change it. */
  readonly ok: boolean;
  readonly violations: readonly ConfigViolation[];
}
export type ConfigEnv = Readonly<Record<string, string | undefined>>;

/** Switches that start or authorize a real external operation. */
export const REAL_OPERATION_FLAGS = Object.freeze([
  'LAUNCH_ENABLED',
  'PAYOUT_ENABLED',
  'X_TRACKING_V2_SETTLEMENT_ENABLED',
]);

/**
 * Everything that can touch real money or real collection: the real-operation switches plus live collection.
 * Used to separate synthetic `WORK_*` switches and to require a declared environment; it adds no authority
 * requirement of its own (`LIVE_COLLECTION_APPROVED` alone demands no operator key).
 */
export const REAL_MONEY_FLAGS = Object.freeze([
  ...REAL_OPERATION_FLAGS,
  'LIVE_COLLECTION_APPROVED',
]);

/** Values of `RAID_ENVIRONMENT` the non-production label recognises (kept equal to `deploymentEnvironment` by a test). */
export const RECOGNISED_ENVIRONMENTS = Object.freeze([
  'production',
  'pilot',
  'staging',
  'alpha',
  'demo',
  'local',
]);

export class ConfigRefusedError extends Error {
  readonly violations: readonly ConfigViolation[];
  constructor(violations: readonly ConfigViolation[]) {
    super(`Unsafe configuration refused: ${describeViolations(violations)}`);
    this.name = 'ConfigRefusedError';
    this.violations = violations;
  }
}

export const describeViolations = (violations: readonly ConfigViolation[]) =>
  violations.map((v) => `${v.code}(${v.subject})`).join(', ');

/** Levenshtein distance, giving up early once it must exceed `limit` (names are short, so this is cheap). */
function withinEdits(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    if (Math.min(...row) > limit) return false;
    previous = row;
  }
  return previous[b.length]! <= limit;
}

/** Database-name words that mark a test database; matched as whole words (`contestants` does not match). */
const TEST_DATABASE_WORDS = Object.freeze([
  'test',
  'tests',
  'testing',
  'e2e',
  'ci',
  'fixture',
  'fixtures',
  'sample',
  'tmp',
  'scratch',
  // DEC-2026-11-13-08 (1): non-production environment names are also refused as whole words.
  'demo',
  'dev',
  'development',
  'local',
  'staging',
]);
/** Well-known placeholder addresses: the system program, any sysvar, and `.env.example`-style stand-ins. */
/**
 * Non-blank `OPERATOR_PUBLIC_KEY` values shipped in `.env.example` (DEC-2026-11-13-08 (2)); refused in production
 * even when no sample prefix matches. The file leaves the key blank today (unset stays allowed), so this is empty;
 * `tests/config-refusals.test.ts` fails if `.env.example` gains a value that is not listed here.
 */
export const ENV_EXAMPLE_OPERATOR_PUBLIC_KEYS: readonly string[] = Object.freeze([]);
const SAMPLE_KEY = /^(1{32}|sysvar|your|sample|example|placeholder|changeme|todo|xxx)/i;

/** `undefined` when unset or blank, `null` when present but not a URL (never echoed). */
function databaseName(url: string | undefined): string | null | undefined {
  if (!url?.trim()) return undefined;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

const present = (env: ConfigEnv, name: string) => (env[name] ?? '').trim() !== '';
const isTrue = (env: ConfigEnv, name: string) => env[name] === 'true';

export function validateRuntimeConfig(env: ConfigEnv, role: ConfigRole): ConfigValidation {
  const violations: ConfigViolation[] = [];
  const add = (severity: ViolationSeverity, code: ViolationCode, subject: string) => {
    if (!violations.some((v) => v.code === code && v.subject === subject))
      violations.push(Object.freeze({ severity, code, subject }));
  };
  const known = new Set(FLAG_CATALOG.map((flag) => flag.name));

  // Exact-string switches: only the empty string (unset) or exactly 'true' / 'false'.
  for (const flag of FLAG_CATALOG) {
    const value = env[flag.name];
    if (value === undefined || value === '' || value === 'true' || value === 'false') continue;
    add(flag.impact === 'HIGH' ? 'REFUSE' : 'WARN', 'FLAG_VALUE_NOT_EXACT', flag.name);
  }
  // Only names that share a leading word with a catalogued switch: ambient variables from the operating
  // system or tooling (for example a terminal's `*_ENABLED`) are not ours to judge.
  const families = new Set(FLAG_CATALOG.map((flag) => flag.name.split('_')[0]));
  for (const name of Object.keys(env))
    if (
      /^[A-Z][A-Z0-9_]*_(ENABLED|APPROVED)$/.test(name) &&
      !known.has(name) &&
      families.has(name.split('_')[0])
    )
      add('WARN', 'UNKNOWN_FLAG', name);
  // A near-miss spelling (wrong case, a dropped or extra letter) of a catalogued switch, in any family: the
  // real switch would silently keep its default while the operator believes it is set.
  for (const name of Object.keys(env)) {
    if (known.has(name) || !/^[A-Za-z][A-Za-z0-9_]{7,}$/.test(name)) continue;
    const upper = name.toUpperCase();
    if (
      FLAG_CATALOG.some(
        (flag) =>
          upper === flag.name || withinEdits(upper, flag.name, flag.name.length < 16 ? 1 : 2),
      )
    )
      add('WARN', 'UNKNOWN_FLAG', name);
  }
  const environment = (env.RAID_ENVIRONMENT ?? '').trim().toLowerCase();
  const moneyFlags = REAL_MONEY_FLAGS.filter((name) => isTrue(env, name));
  // The label must not fail open: under NODE_ENV=production a mistyped label (`prod`, `live`) would skip the
  // production rules below, so it refuses. Unset is allowed only while no money flag is on (the live staging
  // VM sets NODE_ENV=production and no RAID_ENVIRONMENT, with every money flag false).
  if (environment !== '' && !RECOGNISED_ENVIRONMENTS.includes(environment))
    add(
      env.NODE_ENV === 'production' ? 'REFUSE' : 'WARN',
      'ENVIRONMENT_NOT_RECOGNISED',
      'RAID_ENVIRONMENT',
    );
  if (environment === '' && env.NODE_ENV === 'production' && moneyFlags.length > 0)
    add('REFUSE', 'ENVIRONMENT_NOT_DECLARED', 'RAID_ENVIRONMENT');
  for (const flag of FLAG_CATALOG)
    if (flag.requires && isTrue(env, flag.name) && !present(env, flag.requires))
      add('WARN', 'FLAG_SETTING_MISSING', `${flag.name}>${flag.requires}`);

  const realOperations = REAL_OPERATION_FLAGS.filter((name) => isTrue(env, name));
  const missing = (name: string) => add('REFUSE', 'REAL_OPERATION_AUTHORITY_MISSING', name);
  const needChain = () => {
    if (!present(env, 'OPERATOR_PUBLIC_KEY')) missing('OPERATOR_PUBLIC_KEY');
    if (!present(env, 'PLATFORM_TREASURY_ADDRESS')) missing('PLATFORM_TREASURY_ADDRESS');
    needRpc();
  };
  const needRpc = () => {
    if (!(env.SOLANA_RPC_URL ?? '').startsWith('https://')) missing('SOLANA_RPC_URL');
  };
  if (isTrue(env, 'LAUNCH_ENABLED')) needChain();
  if (isTrue(env, 'PAYOUT_ENABLED')) {
    needChain();
    if (role === 'worker' && !present(env, 'OPERATOR_SECRET_KEY')) missing('OPERATOR_SECRET_KEY');
  }
  if (isTrue(env, 'X_TRACKING_V2_SETTLEMENT_ENABLED')) {
    if (!present(env, 'X_ADMIN_USER_ID') && !present(env, 'ADMIN_X_IDS'))
      missing('X_ADMIN_USER_ID|ADMIN_X_IDS');
    if (env.USDC_NETWORK !== 'devnet' && env.USDC_NETWORK !== 'mainnet') missing('USDC_NETWORK');
    if (!present(env, 'USDC_FUNDING_ADDRESS')) missing('USDC_FUNDING_ADDRESS');
    needRpc();
  }

  for (const name of realOperations)
    if (isTrue(env, 'DEMO_MODE')) add('REFUSE', 'REAL_OPERATION_IN_DEMO', name);

  // A worker-only signer or sealed private key must never reach the web process once real operations are on.
  if (role === 'web' && realOperations.length > 0)
    for (const name of Object.keys(env))
      if (
        (name === 'OPERATOR_SECRET_KEY' || /^FEE_SEAL_PRIVATE_\d+$/.test(name)) &&
        present(env, name)
      )
        add('REFUSE', 'SIGNER_SECRET_ON_WEB', name);

  // DEC-2026-11-07-01 (h): synthetic WORK_* switches model simulated funds; they never share a deployment
  // with a switch that can move real money, whatever RAID_ENVIRONMENT says.
  for (const money of moneyFlags)
    for (const flag of FLAG_CATALOG)
      if (flag.name.startsWith('WORK_') && isTrue(env, flag.name))
        add('REFUSE', 'SYNTHETIC_WITH_REAL_MONEY', `${flag.name}>${money}`);

  // DEC-2026-11-07-01 (e)(g): a deployment that declares itself production refuses devnet/demo/test settings.
  // Keyed on RAID_ENVIRONMENT (not NODE_ENV, which staging also sets to production).
  if (environment === 'production') {
    if (env.USDC_NETWORK === 'devnet')
      add('REFUSE', 'DEVNET_OR_DEMO_IN_PRODUCTION', 'USDC_NETWORK');
    if ((env.SOLANA_RPC_URL ?? '').toLowerCase().includes('devnet'))
      add('REFUSE', 'DEVNET_OR_DEMO_IN_PRODUCTION', 'SOLANA_RPC_URL');
    for (const name of ['DEMO_MODE', 'STUDIO_SANDBOX'])
      if (isTrue(env, name)) add('REFUSE', 'DEVNET_OR_DEMO_IN_PRODUCTION', name);
    const database = databaseName(env.DATABASE_URL);
    if (database === null) add('REFUSE', 'DATABASE_URL_UNPARSEABLE', 'DATABASE_URL');
    else if (
      database &&
      database
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((w) => TEST_DATABASE_WORDS.includes(w))
    )
      add('REFUSE', 'TEST_DATABASE_IN_PRODUCTION', 'DATABASE_URL');
    const operatorKey = (env.OPERATOR_PUBLIC_KEY ?? '').trim();
    if (SAMPLE_KEY.test(operatorKey) || ENV_EXAMPLE_OPERATOR_PUBLIC_KEYS.includes(operatorKey))
      add('REFUSE', 'SAMPLE_OPERATOR_KEY_IN_PRODUCTION', 'OPERATOR_PUBLIC_KEY');
  }

  if (env.NODE_ENV === 'production')
    for (const name of ['STUDIO_SANDBOX', 'ALLOW_REMOTE_TEST_DB'])
      if (isTrue(env, name)) add('REFUSE', 'TEST_MODE_IN_PRODUCTION', name);

  return Object.freeze({
    ok: !violations.some((v) => v.severity === 'REFUSE'),
    violations: Object.freeze(violations),
  });
}

/** Returns warnings; throws `ConfigRefusedError` (refusals only) when any refusal exists. */
export function assertRuntimeConfig(env: ConfigEnv, role: ConfigRole): readonly ConfigViolation[] {
  const result = validateRuntimeConfig(env, role);
  if (!result.ok)
    throw new ConfigRefusedError(result.violations.filter((v) => v.severity === 'REFUSE'));
  return result.violations;
}
