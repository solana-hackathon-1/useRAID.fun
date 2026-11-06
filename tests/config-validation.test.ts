import { describe, expect, it } from 'vitest';
import {
  ConfigRefusedError,
  FLAG_CATALOG,
  assertRuntimeConfig,
  validateRuntimeConfig,
  type ConfigViolation,
} from '../src/config-validation/index';

// T037 (D12, I12, AC41): unsafe configuration is refused before privileged work starts.
const SECRET = 'sentinel-secret-value-must-never-be-echoed';
const codes = (violations: readonly ConfigViolation[]) =>
  violations.map((v) => `${v.severity}:${v.code}:${v.subject}`).sort();

// The values compose.staging.yaml pins on every staging service (the "safe environment").
const STAGING = {
  NODE_ENV: 'production',
  DEMO_MODE: 'false',
  ACCOUNT_FOLDS_ENABLED: 'false',
  WALLET_LINKS_ENABLED: 'false',
  STUDIO_SANDBOX: 'false',
  ALLOW_REMOTE_TEST_DB: 'false',
  LIVE_COLLECTION_APPROVED: 'false',
  X_TRACKING_V2_ENABLED: 'false',
  X_TRACKING_V2_SETTLEMENT_ENABLED: 'false',
  LAUNCH_ENABLED: 'false',
  PAYOUT_ENABLED: 'false',
  DATABASE_URL: `postgresql://useraid:${SECRET}@db:5432/useraid_staging`,
  TRUSTED_IP_HEADER: 'x-forwarded-for',
};
const REAL_AUTHORITY = {
  OPERATOR_PUBLIC_KEY: 'pubkey',
  PLATFORM_TREASURY_ADDRESS: 'treasury',
  SOLANA_RPC_URL: 'https://rpc.invalid',
};

describe('validateRuntimeConfig', () => {
  it('accepts an empty environment: every flag is off by default except documented tracking v2', () => {
    const result = validateRuntimeConfig({}, 'web');
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    for (const flag of FLAG_CATALOG)
      expect(flag.defaultState, flag.name).toBe(flag.name === 'X_TRACKING_V2_ENABLED' ? 'ON' : 'OFF');
  });

  it('accepts the pinned staging values for both roles', () => {
    for (const role of ['web', 'worker'] as const)
      expect(validateRuntimeConfig(STAGING, role), role).toEqual({ ok: true, violations: [] });
  });

  it('accepts empty strings as unset and exact true/false', () => {
    const result = validateRuntimeConfig(
      { LAUNCH_ENABLED: '', WORK_START_ENABLED: 'false', WORK_REVIEWS_ENABLED: 'true' },
      'web',
    );
    expect(result.violations).toEqual([]);
  });

  it('refuses a non-exact value for a high-impact switch and never echoes the value', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', ' true', 'true ', 'on']) {
      const result = validateRuntimeConfig({ PAYOUT_ENABLED: value, SECRET_NOTE: SECRET }, 'web');
      expect(result.ok, value).toBe(false);
      expect(codes(result.violations), value).toContain(
        'REFUSE:FLAG_VALUE_NOT_EXACT:PAYOUT_ENABLED',
      );
      expect(result.violations).toEqual([
        { severity: 'REFUSE', code: 'FLAG_VALUE_NOT_EXACT', subject: 'PAYOUT_ENABLED' },
      ]);
    }
  });

  it('treats a mistyped default-on switch as a refusal: anything but "false" leaves tracking on', () => {
    const result = validateRuntimeConfig({ X_TRACKING_V2_ENABLED: 'False' }, 'web');
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toEqual([
      'REFUSE:FLAG_VALUE_NOT_EXACT:X_TRACKING_V2_ENABLED',
    ]);
  });

  it('only warns for a non-exact routine feature flag (code already treats it as off)', () => {
    const result = validateRuntimeConfig({ WORK_START_ENABLED: 'yes' }, 'web');
    expect(result.ok).toBe(true);
    expect(codes(result.violations)).toEqual(['WARN:FLAG_VALUE_NOT_EXACT:WORK_START_ENABLED']);
  });

  it('warns on an unknown *_ENABLED / *_APPROVED variable, which would otherwise be silently ignored', () => {
    const result = validateRuntimeConfig({ WORK_STRT_ENABLED: 'true' }, 'web');
    expect(result.ok).toBe(true);
    expect(codes(result.violations)).toEqual(['WARN:UNKNOWN_FLAG:WORK_STRT_ENABLED']);
  });

  it('refuses launch and payout without their named authorities', () => {
    for (const flag of ['LAUNCH_ENABLED', 'PAYOUT_ENABLED']) {
      const result = validateRuntimeConfig({ [flag]: 'true' }, 'web');
      expect(result.ok, flag).toBe(false);
      expect(codes(result.violations), flag).toEqual([
        'REFUSE:REAL_OPERATION_AUTHORITY_MISSING:OPERATOR_PUBLIC_KEY',
        'REFUSE:REAL_OPERATION_AUTHORITY_MISSING:PLATFORM_TREASURY_ADDRESS',
        'REFUSE:REAL_OPERATION_AUTHORITY_MISSING:SOLANA_RPC_URL',
      ]);
    }
    expect(
      validateRuntimeConfig({ LAUNCH_ENABLED: 'true', ...REAL_AUTHORITY, SOLANA_RPC_URL: 'http://x' }, 'web')
        .violations.map((v) => v.subject),
    ).toEqual(['SOLANA_RPC_URL']);
  });

  it('requires the worker signer for payouts and keeps signer secrets off the web role', () => {
    const payout = { PAYOUT_ENABLED: 'true', ...REAL_AUTHORITY };
    expect(validateRuntimeConfig(payout, 'web').ok).toBe(true);
    expect(codes(validateRuntimeConfig(payout, 'worker').violations)).toEqual([
      'REFUSE:REAL_OPERATION_AUTHORITY_MISSING:OPERATOR_SECRET_KEY',
    ]);
    expect(validateRuntimeConfig({ ...payout, OPERATOR_SECRET_KEY: SECRET }, 'worker').ok).toBe(true);
    const onWeb = validateRuntimeConfig({ ...payout, OPERATOR_SECRET_KEY: SECRET }, 'web');
    expect(codes(onWeb.violations)).toEqual(['REFUSE:SIGNER_SECRET_ON_WEB:OPERATOR_SECRET_KEY']);
    const sealed = validateRuntimeConfig({ ...payout, FEE_SEAL_PRIVATE_2: SECRET }, 'web');
    expect(codes(sealed.violations)).toEqual(['REFUSE:SIGNER_SECRET_ON_WEB:FEE_SEAL_PRIVATE_2']);
    expect(JSON.stringify([onWeb, sealed])).not.toContain(SECRET);
  });

  it('refuses settlement without an administrator, an explicit network, a funding address and https RPC', () => {
    const result = validateRuntimeConfig({ X_TRACKING_V2_SETTLEMENT_ENABLED: 'true' }, 'web');
    expect(codes(result.violations)).toEqual([
      'REFUSE:REAL_OPERATION_AUTHORITY_MISSING:USDC_FUNDING_ADDRESS',
      'REFUSE:REAL_OPERATION_AUTHORITY_MISSING:USDC_NETWORK',
      'REFUSE:REAL_OPERATION_AUTHORITY_MISSING:SOLANA_RPC_URL',
      'REFUSE:REAL_OPERATION_AUTHORITY_MISSING:X_ADMIN_USER_ID|ADMIN_X_IDS',
    ].sort());
    const ok = {
      X_TRACKING_V2_SETTLEMENT_ENABLED: 'true',
      ADMIN_X_IDS: '123',
      USDC_NETWORK: 'devnet',
      USDC_FUNDING_ADDRESS: 'addr',
      SOLANA_RPC_URL: 'https://rpc.invalid',
    };
    expect(validateRuntimeConfig(ok, 'web').ok).toBe(true);
    expect(validateRuntimeConfig({ ...ok, USDC_NETWORK: 'testnet' }, 'web').ok).toBe(false);
    expect(validateRuntimeConfig({ ...ok, USDC_NETWORK: '' }, 'web').ok).toBe(false);
  });

  it('refuses test and sandbox switches in production but not in development', () => {
    for (const flag of ['STUDIO_SANDBOX', 'ALLOW_REMOTE_TEST_DB']) {
      const prod = validateRuntimeConfig({ NODE_ENV: 'production', [flag]: 'true' }, 'web');
      expect(codes(prod.violations), flag).toEqual([`REFUSE:TEST_MODE_IN_PRODUCTION:${flag}`]);
      expect(validateRuntimeConfig({ NODE_ENV: 'development', [flag]: 'true' }, 'web').ok).toBe(true);
    }
  });

  it('refuses any real-operation switch in demo mode', () => {
    for (const flag of ['LAUNCH_ENABLED', 'PAYOUT_ENABLED', 'X_TRACKING_V2_SETTLEMENT_ENABLED']) {
      const result = validateRuntimeConfig({ DEMO_MODE: 'true', [flag]: 'true', ...REAL_AUTHORITY }, 'web');
      expect(codes(result.violations), flag)
        .toContain(`REFUSE:REAL_OPERATION_IN_DEMO:${flag}`);
    }
  });

  it('warns when a catalog switch is on but its named setting is missing (code stays closed)', () => {
    const result = validateRuntimeConfig(
      { WORK_ACCEPTANCE_ENABLED: 'true', PRACTICE_PORTAL_READS_ENABLED: 'true' },
      'web',
    );
    expect(result.ok).toBe(true);
    expect(codes(result.violations)).toEqual([
      'WARN:FLAG_SETTING_MISSING:PRACTICE_PORTAL_READS_ENABLED>PRACTICE_TRIAL_CATALOG_ID',
      'WARN:FLAG_SETTING_MISSING:WORK_ACCEPTANCE_ENABLED>WORK_ACCEPTANCE_TAXONOMY_ID',
    ]);
  });

  it('reports every violation without leaking any configured value', () => {
    const result = validateRuntimeConfig(
      { LAUNCH_ENABLED: 'true', OPERATOR_SECRET_KEY: SECRET, DATABASE_URL: SECRET, WORK_X_ENABLED: SECRET },
      'web',
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('assertRuntimeConfig', () => {
  it('returns warnings and throws a value-free ConfigRefusedError on refusal', () => {
    expect(assertRuntimeConfig({ WORK_START_ENABLED: 'yes' }, 'web')).toHaveLength(1);
    let caught: unknown;
    try {
      assertRuntimeConfig({ PAYOUT_ENABLED: 'true', DATABASE_URL: SECRET }, 'worker');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigRefusedError);
    const error = caught as ConfigRefusedError;
    expect(error.violations.every((v) => v.severity === 'REFUSE')).toBe(true);
    expect(error.message).toContain('REAL_OPERATION_AUTHORITY_MISSING');
    expect(error.message).toContain('OPERATOR_SECRET_KEY');
    expect(error.message).not.toContain(SECRET);
  });
});
