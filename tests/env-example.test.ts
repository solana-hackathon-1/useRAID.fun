import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackingEnabled } from '@/lib/config';

const root = join(__dirname, '..');
const example = readFileSync(join(root, '.env.example'), 'utf8');
const documented = new Set(
  [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]),
);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const platform = new Set(['NODE_ENV', 'NEXT_DIST_DIR', 'APP_URL', 'PORT', 'CI']);

describe('.env.example', () => {
  it('documents every variable the application reads', () => {
    const used = new Set<string>();
    for (const dir of ['src', 'scripts']) {
      for (const file of sources(join(root, dir))) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
        for (const m of text.matchAll(/Reflect\.get\(process\.env,\s*'([A-Z][A-Z0-9_]+)'/g))
          used.add(m[1]);
      }
    }
    const missing = [...used].filter((name) => !documented.has(name) && !platform.has(name));
    expect(missing).toEqual([]);
  });

  it('documents the money, budget and key variables', () => {
    for (const name of [
      'RAID_AUTHOR_CAP_BPS',
      'SOL_MIN_PAYOUT_LAMPORTS',
      'USDC_MIN_REWARD_UNITS',
      'USDC_MIN_DEPOSIT_UNITS',
      'USDC_MIN_WITHDRAWAL_UNITS',
      'USDC_MAX_OPEN_DEPOSITS',
      'USDC_MAX_OPEN_WITHDRAWALS',
      'STUDIO_LOOKUPS_PER_DAY',
      'X_REFRESH_MINUTES',
      'X_SEARCH_QUERY_MAX_CHARS',
      'ALLOWED_DEV_ORIGINS',
      'FEE_SEAL_VERSION',
      'FEE_SEAL_PUBLIC_1',
      'FEE_SEAL_PRIVATE_1',
      'LAUNCH_ASSET_KEY',
      'ALLOW_REMOTE_TEST_DB',
    ])
      expect(documented, name).toContain(name);
  });

  it('has Settlement and inert Deferred-launchpad sections', () => {
    expect(example).toMatch(/^# ---- Settlement/m);
    expect(example).toMatch(/^# ---- Deferred launchpad \(INERT\)/m);
    expect(example.indexOf('X_TRACKING_V2_SETTLEMENT_ENABLED=false')).toBeGreaterThan(
      example.indexOf('# ---- Settlement'),
    );
    expect(example.indexOf('LAUNCH_ENABLED=false')).toBeGreaterThan(
      example.indexOf('# ---- Deferred launchpad'),
    );
  });

  it('ships tracking v2 on and settlement off', () => {
    expect(example).toMatch(/^X_TRACKING_V2_ENABLED=true$/m);
    expect(example).toMatch(/^X_TRACKING_V2_SETTLEMENT_ENABLED=false$/m);
  });
});

describe('tracking v2 default', () => {
  it('is on unless explicitly set to false', () => {
    const saved = process.env.X_TRACKING_V2_ENABLED;
    try {
      delete process.env.X_TRACKING_V2_ENABLED;
      expect(trackingEnabled()).toBe(true);
      process.env.X_TRACKING_V2_ENABLED = '';
      expect(trackingEnabled()).toBe(true);
      process.env.X_TRACKING_V2_ENABLED = 'false';
      expect(trackingEnabled()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.X_TRACKING_V2_ENABLED;
      else process.env.X_TRACKING_V2_ENABLED = saved;
    }
  });
});
