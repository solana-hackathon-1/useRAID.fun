import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/db';
import { auditConfigFlags } from '../src/lib/config-flag-audit';
import { assertTestDatabase } from './helpers/db-guard';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const rows = () => db.configFlagChange.findMany({ orderBy: { id: 'asc' } });

suite('DEC-2026-11-13-01 ConfigFlagChange audit on real PostgreSQL', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    // Append-only against row changes; TRUNCATE is how the test database is emptied between cases.
    await db.$executeRawUnsafe('TRUNCATE TABLE "ConfigFlagChange"');
  });
  afterAll(() => db.$disconnect());

  it('first start records the baseline as initial observation, not as changes', async () => {
    const result = await auditConfigFlags('web', {
      RAID_ENVIRONMENT: 'staging',
      RAID_DEPLOYMENT_ID: 'sha-abc123',
      PAYOUT_ENABLED: 'false',
      DATABASE_URL: 'postgresql://u:hunter2@db/x',
    });
    const all = await rows();
    expect(result.recorded).toBe(all.length);
    expect(all.length).toBeGreaterThan(30);
    expect(all.every((r) => r.kind === 'INITIAL_OBSERVATION' && r.previousValue === null)).toBe(
      true,
    );
    expect(all.every((r) => r.environment === 'staging' && r.processKind === 'web')).toBe(true);
    expect(all.every((r) => r.deploymentId === 'sha-abc123')).toBe(true);
    expect(all.every((r) => r.actor === 'deployment, unattributed')).toBe(true);
    expect(all.every((r) => r.recordedAt instanceof Date)).toBe(true);
    expect(JSON.stringify(all, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(
      'hunter2',
    );
  });

  it('an unchanged restart records nothing; a changed flag records one before/after row', async () => {
    const env = { RAID_ENVIRONMENT: 'staging' };
    await auditConfigFlags('web', env);
    const baseline = (await rows()).length;
    expect((await auditConfigFlags('web', env)).recorded).toBe(0);
    expect((await rows()).length).toBe(baseline);

    expect(
      (await auditConfigFlags('web', { ...env, PAYOUT_ENABLED: 'true', RAID_DEPLOYMENT_ID: 'd2' }))
        .recorded,
    ).toBe(1);
    const changed = (await rows()).at(-1)!;
    expect(changed).toMatchObject({
      flagName: 'PAYOUT_ENABLED',
      previousValue: 'unset',
      newValue: 'true',
      kind: 'CHANGE',
      deploymentId: 'd2',
      environment: 'staging',
    });
    // And back again is a second change; the history is kept.
    await auditConfigFlags('web', env);
    expect((await rows()).at(-1)).toMatchObject({ previousValue: 'true', newValue: 'unset' });
  });

  it('keeps web, worker and environments separate and does not store an unsafe deployment id', async () => {
    await auditConfigFlags('web', { RAID_ENVIRONMENT: 'staging' });
    await auditConfigFlags('worker', { RAID_ENVIRONMENT: 'staging', PAYOUT_ENABLED: 'true' });
    const workerRows = (await rows()).filter((r) => r.processKind === 'worker');
    expect(workerRows.every((r) => r.kind === 'INITIAL_OBSERVATION')).toBe(true);
    await auditConfigFlags('web', {
      RAID_ENVIRONMENT: 'prod-typo-sk-live',
      RAID_DEPLOYMENT_ID: 'bad id with spaces & secrets',
    });
    const odd = (await rows()).filter((r) => r.environment !== 'staging');
    expect(odd.length).toBeGreaterThan(0);
    expect(odd.every((r) => r.environment === 'unrecognised' && r.deploymentId === null)).toBe(
      true,
    );
  });

  it('concurrent replicas record one change once', async () => {
    const env = { RAID_ENVIRONMENT: 'staging' };
    await Promise.all(Array.from({ length: 6 }, () => auditConfigFlags('web', env)));
    const baseline = (await rows()).length;
    const flagged = { ...env, WALLET_LINKS_ENABLED: 'true' };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => auditConfigFlags('web', flagged)),
    );
    expect(results.reduce((n, r) => n + r.recorded, 0)).toBe(1);
    expect((await rows()).length).toBe(baseline + 1);
  });

  it('concurrent first starts record the baseline once', async () => {
    const env = { RAID_ENVIRONMENT: 'staging' };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => auditConfigFlags('web', env)),
    );
    const total = (await rows()).length;
    expect(results.reduce((n, r) => n + r.recorded, 0)).toBe(total);
    const names = (await rows()).map((r) => r.flagName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is append-only: update and delete are rejected', async () => {
    await auditConfigFlags('web', { RAID_ENVIRONMENT: 'staging' });
    await expect(
      db.$executeRawUnsafe(`UPDATE "ConfigFlagChange" SET "newValue"='true'`),
    ).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe(`DELETE FROM "ConfigFlagChange"`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('refuses a value or kind outside the closed vocabularies', async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "ConfigFlagChange" ("environment","processKind","flagName","newValue","kind") VALUES ('staging','web','PAYOUT_ENABLED','sk-live-secret','CHANGE')`,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "ConfigFlagChange" ("environment","processKind","flagName","previousValue","newValue","kind") VALUES ('staging','web','PAYOUT_ENABLED','true','true','CHANGE')`,
      ),
    ).rejects.toThrow();
  });

  it('production refuses to start when the audit write fails against a real database', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.$executeRawUnsafe(`ALTER TABLE "ConfigFlagChange" RENAME TO "ConfigFlagChange_x"`);
    try {
      await expect(
        auditConfigFlags('web', { RAID_ENVIRONMENT: 'production' }),
      ).rejects.toMatchObject({ code: 'CONFIG_AUDIT_FAILED' });
      await expect(auditConfigFlags('web', { RAID_ENVIRONMENT: 'staging' })).resolves.toMatchObject(
        { failed: true },
      );
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "ConfigFlagChange_x" RENAME TO "ConfigFlagChange"`);
      quiet.mockRestore();
    }
  });
});
