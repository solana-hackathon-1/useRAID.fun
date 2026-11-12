import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateRuntimeConfig, type ConfigViolation } from '../src/config-validation/index';
import { checkRuntimeConfigOrExit } from '../src/lib/config-validation-host';

// DEC-2026-11-07-01 (e)(f)(g)(h): production refusals, exit-at-start, synthetic/real-money separation.
const SECRET = 'sentinel-secret-value-must-never-be-echoed';
const codes = (violations: readonly ConfigViolation[]) =>
  violations.map((v) => `${v.severity}:${v.code}:${v.subject}`).sort();
const PRODUCTION = {
  RAID_ENVIRONMENT: 'production',
  DATABASE_URL: `postgresql://useraid:${SECRET}@db.internal:5432/useraid`,
};
const REAL_AUTHORITY = {
  OPERATOR_PUBLIC_KEY: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  PLATFORM_TREASURY_ADDRESS: 'treasury',
  SOLANA_RPC_URL: 'https://rpc.invalid',
};

afterEach(() => vi.restoreAllMocks());

describe('(e) production refuses devnet or demo settings', () => {
  it('accepts a clean production environment', () => {
    expect(validateRuntimeConfig(PRODUCTION, 'web')).toEqual({ ok: true, violations: [] });
  });

  it.each([
    [{ USDC_NETWORK: 'devnet' }, 'USDC_NETWORK'],
    [{ DEMO_MODE: 'true' }, 'DEMO_MODE'],
    [{ STUDIO_SANDBOX: 'true' }, 'STUDIO_SANDBOX'],
    [{ SOLANA_RPC_URL: 'https://api.devnet.solana.com' }, 'SOLANA_RPC_URL'],
  ])('refuses %j', (extra, subject) => {
    const result = validateRuntimeConfig({ ...PRODUCTION, ...extra }, 'web');
    expect(result.ok).toBe(false);
    expect(codes(result.violations)).toContain(`REFUSE:DEVNET_OR_DEMO_IN_PRODUCTION:${subject}`);
  });

  it('ignores case and space in the environment name, and does not apply to other environments', () => {
    const bad = { DATABASE_URL: PRODUCTION.DATABASE_URL, USDC_NETWORK: 'devnet' };
    expect(validateRuntimeConfig({ ...bad, RAID_ENVIRONMENT: ' Production ' }, 'web').ok).toBe(
      false,
    );
    for (const value of ['staging', 'pilot', 'alpha', 'demo', 'local', '', undefined])
      expect(
        validateRuntimeConfig({ ...bad, RAID_ENVIRONMENT: value }, 'web').ok,
        String(value),
      ).toBe(true);
  });
});

describe('(g) production refuses test-looking database names and the sample operator key', () => {
  it.each([
    'postgresql://u:p@db:5432/useraid_test',
    'postgresql://u:p@db:5432/test',
    'postgres://u:p@db:5432/useraid-e2e?sslmode=require',
    'postgresql://u:p@db:5432/Useraid_Tests',
    'postgresql://u:p@db:5432/ci_useraid',
  ])('refuses database %s', (url) => {
    const result = validateRuntimeConfig({ ...PRODUCTION, DATABASE_URL: url }, 'web');
    expect(codes(result.violations)).toEqual(['REFUSE:TEST_DATABASE_IN_PRODUCTION:DATABASE_URL']);
  });

  it.each([
    'postgresql://u:p@db:5432/useraid',
    'postgresql://u:p@db:5432/useraid_production',
    'postgresql://u:p@db:5432/contestants', // "test" inside a word is not a token
    'postgresql://u:p@db-test.internal:5432/useraid', // host is not the database name
    '',
  ])('accepts database %s', (url) => {
    expect(validateRuntimeConfig({ ...PRODUCTION, DATABASE_URL: url }, 'web').ok).toBe(true);
  });

  it('test-looking names are fine outside production', () => {
    expect(
      validateRuntimeConfig(
        { RAID_ENVIRONMENT: 'staging', DATABASE_URL: 'postgresql://u:p@db:5432/useraid_test' },
        'web',
      ).ok,
    ).toBe(true);
  });

  it.each([
    '11111111111111111111111111111111',
    'SysvarRent111111111111111111111111111111111',
    'your-operator-public-key',
    'sample',
    'example-key',
    'placeholder',
  ])('refuses sample operator key %s without echoing it', (key) => {
    const result = validateRuntimeConfig({ ...PRODUCTION, OPERATOR_PUBLIC_KEY: key }, 'web');
    expect(codes(result.violations)).toEqual([
      'REFUSE:SAMPLE_OPERATOR_KEY_IN_PRODUCTION:OPERATOR_PUBLIC_KEY',
    ]);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('accepts a real-looking key, unset key, and the sample key outside production', () => {
    expect(validateRuntimeConfig({ ...PRODUCTION, ...REAL_AUTHORITY }, 'web').ok).toBe(true);
    expect(validateRuntimeConfig(PRODUCTION, 'web').ok).toBe(true);
    expect(
      validateRuntimeConfig(
        { RAID_ENVIRONMENT: 'local', OPERATOR_PUBLIC_KEY: '11111111111111111111111111111111' },
        'web',
      ).ok,
    ).toBe(true);
  });

  it('never echoes the database URL', () => {
    const result = validateRuntimeConfig(
      { ...PRODUCTION, DATABASE_URL: `postgresql://u:${SECRET}@db:5432/useraid_test` },
      'web',
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('(h) synthetic WORK_* flags may not coexist with real-money flags', () => {
  it.each([
    ['LAUNCH_ENABLED', REAL_AUTHORITY],
    ['PAYOUT_ENABLED', REAL_AUTHORITY],
  ])('refuses WORK_* with %s in any environment', (money, authority) => {
    for (const environment of ['production', 'staging', undefined]) {
      const result = validateRuntimeConfig(
        {
          RAID_ENVIRONMENT: environment,
          [money]: 'true',
          WORK_START_ENABLED: 'true',
          ...authority,
        },
        'web',
      );
      expect(codes(result.violations), String(environment)).toEqual([
        'REFUSE:SYNTHETIC_WITH_REAL_MONEY:WORK_START_ENABLED>' + money,
      ]);
    }
  });

  it('covers settlement and names every offending pair once', () => {
    const result = validateRuntimeConfig(
      {
        X_TRACKING_V2_SETTLEMENT_ENABLED: 'true',
        X_ADMIN_USER_ID: 'a',
        USDC_NETWORK: 'mainnet',
        USDC_FUNDING_ADDRESS: 'f',
        SOLANA_RPC_URL: 'https://rpc.invalid',
        WORK_REVIEWS_ENABLED: 'true',
        WORK_SUBMISSIONS_ENABLED: 'true',
      },
      'web',
    );
    expect(codes(result.violations)).toEqual([
      'REFUSE:SYNTHETIC_WITH_REAL_MONEY:WORK_REVIEWS_ENABLED>X_TRACKING_V2_SETTLEMENT_ENABLED',
      'REFUSE:SYNTHETIC_WITH_REAL_MONEY:WORK_SUBMISSIONS_ENABLED>X_TRACKING_V2_SETTLEMENT_ENABLED',
    ]);
  });

  it('allows either side alone, and false/unset WORK_* flags beside money flags', () => {
    expect(validateRuntimeConfig({ WORK_START_ENABLED: 'true' }, 'web').ok).toBe(true);
    expect(validateRuntimeConfig({ LAUNCH_ENABLED: 'true', ...REAL_AUTHORITY }, 'web').ok).toBe(
      true,
    );
    expect(
      validateRuntimeConfig(
        { LAUNCH_ENABLED: 'true', ...REAL_AUTHORITY, WORK_START_ENABLED: 'false' },
        'web',
      ).ok,
    ).toBe(true);
    // Non-WORK synthetic-looking flags are not covered by this rule.
    expect(
      validateRuntimeConfig(
        { LAUNCH_ENABLED: 'true', ...REAL_AUTHORITY, GUILD_DRAFTS_ENABLED: 'true' },
        'web',
      ).ok,
    ).toBe(true);
  });
});

describe('(f) a web process refused for bad configuration exits at start', () => {
  it('exits 1 with a value-free log line instead of staying up to answer 500', () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkRuntimeConfigOrExit('web', { ...PRODUCTION, USDC_NETWORK: 'devnet', X: SECRET }, exit);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    const line = String(error.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({
      config: 'refused',
      role: 'web',
      violations: [{ code: 'DEVNET_OR_DEMO_IN_PRODUCTION', subject: 'USDC_NETWORK' }],
    });
    expect(line).not.toContain(SECRET);
  });

  it('does not exit for a valid or warning-only configuration', () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkRuntimeConfigOrExit('web', PRODUCTION, exit);
    checkRuntimeConfigOrExit('web', { WORK_START_ENABLED: 'yes' }, exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it('Next instrumentation register exits the process on refusal, only in the Node runtime', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('RAID_ENVIRONMENT', 'production');
    vi.stubEnv('USDC_NETWORK', 'devnet');
    const { register } = await import('../src/instrumentation');
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(exit).not.toHaveBeenCalled();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    vi.unstubAllEnvs();
  });
});

// Review fix pass: the live staging VM has NODE_ENV=production, NO RAID_ENVIRONMENT and USDC_NETWORK=devnet.
const LIVE_STAGING = {
  NODE_ENV: 'production',
  USDC_NETWORK: 'devnet',
  DEMO_MODE: 'false',
  LIVE_COLLECTION_APPROVED: 'false',
  LAUNCH_ENABLED: 'false',
  PAYOUT_ENABLED: 'false',
  X_TRACKING_V2_SETTLEMENT_ENABLED: 'false',
  DATABASE_URL: 'postgresql://useraid:p@db:5432/useraid_staging',
};

describe('production label cannot fail open (NODE_ENV=production)', () => {
  it('still boots the live staging shape: no RAID_ENVIRONMENT, devnet, every money flag false', () => {
    for (const role of ['web', 'worker'] as const)
      expect(validateRuntimeConfig(LIVE_STAGING, role), role).toEqual({ ok: true, violations: [] });
  });

  it.each(['prod', 'live', 'productoin', 'stagign'])(
    'refuses unrecognised RAID_ENVIRONMENT %s under NODE_ENV=production',
    (value) => {
      const result = validateRuntimeConfig({ ...LIVE_STAGING, RAID_ENVIRONMENT: value }, 'web');
      expect(codes(result.violations)).toEqual([
        'REFUSE:ENVIRONMENT_NOT_RECOGNISED:RAID_ENVIRONMENT',
      ]);
      expect(JSON.stringify(result)).not.toContain(`"${value}"`);
    },
  );

  it('keeps the WARN for an unrecognised label outside NODE_ENV=production', () => {
    expect(codes(validateRuntimeConfig({ RAID_ENVIRONMENT: 'prod' }, 'web').violations)).toEqual([
      'WARN:ENVIRONMENT_NOT_RECOGNISED:RAID_ENVIRONMENT',
    ]);
  });

  it.each([
    ['LAUNCH_ENABLED', REAL_AUTHORITY],
    ['PAYOUT_ENABLED', REAL_AUTHORITY],
    ['LIVE_COLLECTION_APPROVED', {}],
  ])('refuses an undeclared environment when %s is true', (money, authority) => {
    for (const blank of [undefined, '', '  ']) {
      const result = validateRuntimeConfig(
        { ...LIVE_STAGING, ...authority, [money]: 'true', RAID_ENVIRONMENT: blank },
        'web',
      );
      expect(codes(result.violations), String(blank)).toEqual([
        'REFUSE:ENVIRONMENT_NOT_DECLARED:RAID_ENVIRONMENT',
      ]);
    }
  });

  it('accepts money flags once the environment is declared with a recognised label', () => {
    expect(
      validateRuntimeConfig(
        {
          ...LIVE_STAGING,
          USDC_NETWORK: 'mainnet',
          ...REAL_AUTHORITY,
          LAUNCH_ENABLED: 'true',
          RAID_ENVIRONMENT: 'pilot',
        },
        'web',
      ).ok,
    ).toBe(true);
  });

  it('does not require a declaration outside NODE_ENV=production', () => {
    expect(validateRuntimeConfig({ LAUNCH_ENABLED: 'true', ...REAL_AUTHORITY }, 'web').ok).toBe(
      true,
    );
  });
});

describe('LIVE_COLLECTION_APPROVED counts as a real-money flag for (h)', () => {
  it('refuses WORK_* beside it', () => {
    const result = validateRuntimeConfig(
      { LIVE_COLLECTION_APPROVED: 'true', WORK_START_ENABLED: 'true' },
      'web',
    );
    expect(codes(result.violations)).toEqual([
      'REFUSE:SYNTHETIC_WITH_REAL_MONEY:WORK_START_ENABLED>LIVE_COLLECTION_APPROVED',
    ]);
  });

  it('does not make it demand operator authorities on its own', () => {
    expect(validateRuntimeConfig({ LIVE_COLLECTION_APPROVED: 'true' }, 'web').ok).toBe(true);
  });
});

describe('unparseable DATABASE_URL in production', () => {
  it.each(['not a url', 'postgresql//missing-colon', '://x'])(
    'refuses %j without echoing it',
    (url) => {
      const result = validateRuntimeConfig({ ...PRODUCTION, DATABASE_URL: url }, 'web');
      expect(codes(result.violations)).toEqual(['REFUSE:DATABASE_URL_UNPARSEABLE:DATABASE_URL']);
      expect(JSON.stringify(result)).not.toContain(url);
    },
  );

  it('is not judged outside production, and an unset URL is not this rule', () => {
    expect(
      validateRuntimeConfig({ RAID_ENVIRONMENT: 'staging', DATABASE_URL: 'not a url' }, 'web').ok,
    ).toBe(true);
    expect(validateRuntimeConfig({ RAID_ENVIRONMENT: 'production' }, 'web').ok).toBe(true);
  });
});
