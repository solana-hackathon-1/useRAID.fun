import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { FLAG_CATALOG, diffFlagSnapshots, flagSnapshot } from '../src/config-validation/index';
import { auditConfigFlags, auditConfigFlagsOrExit } from '../src/lib/config-flag-audit';

afterEach(() => vi.restoreAllMocks());

describe('DEC-2026-11-13-01 flag snapshot (pure)', () => {
  it('records catalogued flags as exactly true, false, unset or invalid and never any other text', () => {
    const snapshot = flagSnapshot({
      PAYOUT_ENABLED: 'true',
      LAUNCH_ENABLED: 'false',
      WORK_START_ENABLED: 'sk-live-supersecret',
      OPERATOR_SECRET_KEY: 'sk-live-supersecret',
      DATABASE_URL: 'postgresql://u:hunter2@db/x',
    });
    expect(snapshot.PAYOUT_ENABLED).toBe('true');
    expect(snapshot.LAUNCH_ENABLED).toBe('false');
    expect(snapshot.WORK_START_ENABLED).toBe('invalid');
    expect(snapshot.DEMO_MODE).toBe('unset');
    expect(Object.keys(snapshot)).toEqual(expect.arrayContaining(FLAG_CATALOG.map((f) => f.name)));
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain('supersecret');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('OPERATOR_SECRET_KEY');
    expect(text).not.toContain('DATABASE_URL');
  });

  it('adds an unknown flag in a catalogued family but ignores ambient and non-flag variables', () => {
    const snapshot = flagSnapshot({
      WORK_NEW_THING_ENABLED: 'true',
      ITERM_FANCY_ENABLED: 'true',
      PAYOUT_SECRET: 'true',
    });
    expect(snapshot.WORK_NEW_THING_ENABLED).toBe('true');
    expect(snapshot).not.toHaveProperty('ITERM_FANCY_ENABLED');
    expect(snapshot).not.toHaveProperty('PAYOUT_SECRET');
  });

  it('diffs a snapshot: baseline is observation, an unchanged restart is empty, a change is one entry', () => {
    const base = flagSnapshot({});
    expect(diffFlagSnapshots(null, base).every((c) => c.kind === 'INITIAL_OBSERVATION')).toBe(true);
    expect(diffFlagSnapshots(base, flagSnapshot({}))).toEqual([]);
    expect(diffFlagSnapshots(base, flagSnapshot({ PAYOUT_ENABLED: 'true' }))).toEqual([
      { flag: 'PAYOUT_ENABLED', previous: 'unset', next: 'true', kind: 'CHANGE' },
    ]);
  });

  it('a flag first seen after the baseline is a change only when it is not unset', () => {
    const base = { DEMO_MODE: 'unset' } as const;
    const next = { DEMO_MODE: 'unset', NEW_ENABLED: 'true', QUIET_ENABLED: 'unset' } as const;
    expect(diffFlagSnapshots(base, next)).toEqual([
      { flag: 'NEW_ENABLED', previous: null, next: 'true', kind: 'CHANGE' },
      { flag: 'QUIET_ENABLED', previous: null, next: 'unset', kind: 'INITIAL_OBSERVATION' },
    ]);
  });

  it('a flag that disappears from the environment is recorded as unset', () => {
    expect(diffFlagSnapshots({ OLD_ENABLED: 'true' }, {})).toEqual([
      { flag: 'OLD_ENABLED', previous: 'true', next: 'unset', kind: 'CHANGE' },
    ]);
  });
});

const failing = {
  $transaction: async () => {
    throw Object.assign(new Error('connect ECONNREFUSED postgresql://u:hunter2@db'), {
      code: 'P1001',
    });
  },
};

describe('production refuses to start when the flag audit cannot be written', () => {
  it('production: throws a code-only error, never echoing the cause', async () => {
    const error = await auditConfigFlags('web', { RAID_ENVIRONMENT: 'production' }, failing).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'CONFIG_AUDIT_FAILED' });
    expect(String((error as Error).message)).not.toContain('hunter2');
  });

  it('production web exits with code 1 after one redacted log line', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }) as unknown as (code: number) => never;
    await expect(
      auditConfigFlagsOrExit('web', { RAID_ENVIRONMENT: ' Production ' }, failing, exit),
    ).rejects.toThrow('exit 1');
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain('config-flag-audit-failed');
    expect(line).not.toContain('hunter2');
  });

  it.each(['staging', 'local', undefined, 'prod'])(
    'non-production (%s) logs a code-plus-class alert and continues',
    async (environment) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(
        auditConfigFlags('worker', { RAID_ENVIRONMENT: environment }, failing),
      ).resolves.toEqual({ recorded: 0, failed: true });
      expect(String(log.mock.calls[0]![0])).not.toContain('hunter2');
    },
  );
});

describe('audit transaction and start-up policy', () => {
  it('bounds the wait for the table lock before taking it', async () => {
    const sql: string[] = [];
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray) => {
        sql.push(strings.join('?'));
        return 0;
      },
      $queryRaw: async () => [],
      configFlagChange: { createMany: async () => ({ count: 0 }) },
    };
    await auditConfigFlags('web', { RAID_ENVIRONMENT: 'staging' }, {
      $transaction: async (fn: (t: typeof tx) => Promise<number>) => fn(tx),
    } as never);
    expect(sql[0]).toMatch(/SET LOCAL lock_timeout = '5s'/);
    expect(sql[1]).toMatch(/LOCK TABLE "ConfigFlagChange"/);
  });

  it('web in demo mode skips the audit (no database is required there)', async () => {
    const transaction = vi.fn();
    await expect(
      auditConfigFlagsOrExit('web', { DEMO_MODE: 'true', RAID_ENVIRONMENT: 'demo' }, {
        $transaction: transaction,
      } as never),
    ).resolves.toEqual({ recorded: 0, skipped: true });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('an invalid deployment id is ignored with one value-free log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const written: unknown[] = [];
    const tx = {
      $executeRaw: async () => 0,
      $queryRaw: async () => [],
      configFlagChange: {
        createMany: async ({ data }: { data: unknown[] }) => (written.push(...data), { count: 1 }),
      },
    };
    await auditConfigFlags('web', { RAID_DEPLOYMENT_ID: 'bad id & hunter2' }, {
      $transaction: async (fn: (t: typeof tx) => Promise<number>) => fn(tx),
    } as never);
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((r) => (r as { deploymentId: unknown }).deploymentId === null)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({ config: 'deployment-id-ignored', role: 'web' });
    expect(line).not.toContain('hunter2');
  });
});

describe('wiring', () => {
  const text = (p: string) => readFileSync(p, 'utf8');
  it('web audits after validation; the worker audits after the schema check and before any job', () => {
    const web = text('src/instrumentation.ts');
    expect(web.indexOf("checkRuntimeConfigOrExit('web')")).toBeLessThan(
      web.indexOf("auditConfigFlagsOrExit('web')"),
    );
    const worker = text('src/worker.ts');
    expect(worker.indexOf('assertSchemaCurrent()')).toBeLessThan(
      worker.indexOf("auditConfigFlags('worker')"),
    );
    expect(worker.indexOf("auditConfigFlags('worker')")).toBeLessThan(worker.indexOf('claimJob()'));
  });
});
