import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { claimJob, enqueue } from '../src/lib/queue';
import { runJob, schedule, step } from '../src/lib/worker-jobs';
import { resetRecordingBreaker } from '../src/lib/worker-health';
import {
  correlationFields,
  withCorrelation,
  newRunCorrelationId,
} from '../src/lib/worker-diagnostics';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const MINT = 'So11111111111111111111111111111111111111112';

suite('correlated sanitized worker diagnostics (T038 W03)', () => {
  let logs: Record<string, unknown>[];
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
  });
  beforeEach(async () => {
    await truncateAll(db);
    await db.$executeRawUnsafe('DELETE FROM "WorkerStepHealth"');
    resetRecordingBreaker();
    logs = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      try {
        logs.push(JSON.parse(String(line)));
      } catch {
        logs.push({ raw: String(line) });
      }
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  afterAll(() => db.$disconnect());

  it('adds no field outside a correlated scope, and refuses an id that could carry free text', async () => {
    expect(correlationFields()).toEqual({});
    await withCorrelation('run-abc123', async () => {
      expect(correlationFields()).toEqual({ correlationId: 'run-abc123' });
    });
    expect(() => withCorrelation('token sk-live-123 in provider body', async () => {})).toThrow();
    expect(newRunCorrelationId()).toMatch(/^run-[0-9a-f]{12}$/);
    expect(newRunCorrelationId()).not.toBe(newRunCorrelationId());
  });

  it('puts the same correlation id on a failing step log and the health-store log', async () => {
    vi.spyOn(db, '$executeRaw').mockRejectedValue(new Error('db down'));
    await withCorrelation('run-abc123', () =>
      step('alpha', async () => {
        throw new Error('boom');
      }),
    );
    const stepLog = logs.find((l) => l.step === 'alpha');
    const healthLog = logs.find((l) => l.step === 'worker-health');
    expect(stepLog).toMatchObject({
      step: 'alpha',
      code: 'UNCLASSIFIED',
      errorClass: 'Error',
      correlationId: 'run-abc123',
    });
    expect(healthLog).toMatchObject({ correlationId: 'run-abc123' });
  });

  it('gives each schedule() run one id shared by all of its step logs, and a new id next time', async () => {
    const fail = vi.spyOn(db.raid, 'updateMany').mockRejectedValue(new Error('synthetic failure'));
    await schedule(new Date());
    const first = logs.filter((l) => typeof l.step === 'string' && l.step !== 'worker-health');
    expect(first.map((l) => l.step)).toEqual(
      expect.arrayContaining(['status-transitions', 'coverage-expired']),
    );
    const ids = new Set(first.map((l) => l.correlationId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^run-[0-9a-f]{12}$/);
    logs.length = 0;
    await schedule(new Date());
    const second = new Set(logs.filter((l) => l.step).map((l) => l.correlationId));
    expect(second.size).toBe(1);
    expect(second.has([...ids][0])).toBe(false);
    fail.mockRestore();
  });

  it('keeps one job correlation id across retries and puts it on failure and lease-lost logs', async () => {
    await db.token.create({ data: { mint: MINT, symbol: 'SOL', name: 'Solana' } });
    await enqueue('market', 'market:corr:1', { mint: MINT }, new Date(Date.now() - 60_000));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('secret-provider-body sk-live-123', { status: 500 })),
    );
    const first = (await claimJob())!;
    await runJob(first);
    await db.$executeRaw`UPDATE "Job" SET "runAt"=NOW() AT TIME ZONE 'UTC' - INTERVAL '1 second' WHERE id=${first.id}`;
    const second = (await claimJob())!;
    expect(second.id).toBe(first.id);
    await db.$executeRaw`UPDATE "Job" SET "lockedAt"=(NOW() AT TIME ZONE 'UTC')-INTERVAL '11 minutes' WHERE id=${first.id}`;
    const stolen = (await claimJob())!;
    await runJob(second); // lease lost: logs and returns
    const jobLogs = logs.filter((l) => l.job === first.id);
    expect(jobLogs.length).toBeGreaterThanOrEqual(2);
    for (const l of jobLogs) expect(l.correlationId).toBe(`job-${first.id}`);
    expect(stolen.lease).not.toBe(second.lease);
    // No lease token or payload in any diagnostic line.
    const text = JSON.stringify(logs);
    for (const secret of [stolen.lease!, second.lease!, first.lease!])
      expect(text).not.toContain(secret);
    expect(text).not.toContain(MINT);
  });
});
