import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLAG_CATALOG,
  RECOGNISED_ENVIRONMENTS,
  validateRuntimeConfig,
} from '../src/config-validation/index';
import { deploymentEnvironment } from '../src/lib/deployment-environment';
import { checkRuntimeConfig } from '../src/lib/config-validation-host';

const text = (path: string) => readFileSync(path, 'utf8');
const pairs = (source: string) =>
  [...source.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*'([^']*)'\s*$/gm)].map(
    (m) => [m[1], m[2]] as const,
  );
const stagingPinned = () => {
  const block = text('compose.staging.yaml').split('safe-environment')[1]!.split('depends_on')[0]!;
  return Object.fromEntries(pairs(block));
};

afterEach(() => vi.restoreAllMocks());

describe('T037 startup host (web instrumentation and worker)', () => {
  it('staging still boots: compose pins every high-impact switch, so no refusal can occur there', () => {
    const pinned = stagingPinned();
    for (const flag of FLAG_CATALOG.filter((f) => f.impact === 'HIGH'))
      expect(pinned[flag.name], flag.name).toBe('false');
    // Whatever the env files add, the pinned values win (compose `environment` overrides `env_file`).
    const env = {
      ...pinned,
      DATABASE_URL: 'postgresql://u:p@db:5432/useraid_staging',
      OPERATOR_SECRET_KEY: 'present-but-inert',
      NEXT_PUBLIC_APP_URL: 'https://staging.useraid.fun',
    };
    for (const role of ['web', 'worker'] as const)
      expect(validateRuntimeConfig(env, role), role).toEqual({ ok: true, violations: [] });
  });

  it('accepts the documented example file and the live-browser CI fixture; refuses a mutated copy', () => {
    const example = Object.fromEntries(
      [...text('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    for (const role of ['web', 'worker'] as const)
      expect(validateRuntimeConfig(example, role).ok, role).toBe(true);
    const live = {
      DEMO_MODE: 'false',
      ADMIN_X_IDS: 'gate-admin-x',
      X_TRACKING_V2_ENABLED: 'true',
      LIVE_COLLECTION_APPROVED: 'true',
      LAUNCH_ENABLED: 'true',
      PAYOUT_ENABLED: 'true',
      OPERATOR_PUBLIC_KEY: '11111111111111111111111111111111',
      PLATFORM_TREASURY_ADDRESS: 'SysvarRent111111111111111111111111111111111',
      X_BEARER_TOKEN: 'fixture',
      SOLANA_RPC_URL: 'https://example.invalid',
      PINATA_JWT: 'fixture',
      NODE_ENV: 'production',
    };
    expect(validateRuntimeConfig(live, 'web').ok).toBe(true);
    expect(validateRuntimeConfig({ ...example, PAYOUT_ENABLED: 'true' }, 'web').ok).toBe(false);
  });

  it('refuses via checkRuntimeConfig and logs warnings as names and codes only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => checkRuntimeConfig('worker', { LAUNCH_ENABLED: 'true' })).toThrow(
      /REAL_OPERATION_AUTHORITY_MISSING\(OPERATOR_PUBLIC_KEY\)/,
    );
    expect(
      checkRuntimeConfig('web', { WORK_START_ENABLED: 'yes', SECRET: 'abc-secret' }),
    ).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({
      config: 'warning',
      role: 'web',
      severity: 'WARN',
      code: 'FLAG_VALUE_NOT_EXACT',
      subject: 'WORK_START_ENABLED',
    });
    expect(line).not.toContain('abc-secret');
  });

  it('web and worker entry points call the host before serving or touching the schema', () => {
    const worker = text('src/worker.ts');
    expect(worker).toContain("checkRuntimeConfig('worker')");
    expect(worker.indexOf("checkRuntimeConfig('worker')")).toBeLessThan(
      worker.indexOf('assertSchemaCurrent()'),
    );
    const web = text('src/instrumentation.ts');
    expect(web).toContain("checkRuntimeConfig('web')");
    expect(web).toContain("NEXT_RUNTIME !== 'nodejs'");
  });

  it('recognises exactly the RAID_ENVIRONMENT names the non-production label declares', () => {
    for (const value of RECOGNISED_ENVIRONMENTS)
      expect(deploymentEnvironment({ RAID_ENVIRONMENT: value }).declared, value).toBe(true);
    for (const value of ['prod', 'live', 'staging2'])
      expect(deploymentEnvironment({ RAID_ENVIRONMENT: value }).declared, value).toBe(false);
  });
});
