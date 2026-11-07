// DEC-2026-11-07-01 (d): worker operator logs carry a code plus a safe class only. Drives the real step(),
// runJob() failure path (including the failed-bookkeeping and health-store paths) with errors whose message,
// cause and properties carry sentinel secrets, and asserts nothing but the safe fields reaches the console.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { claimJob, enqueue } from '../src/lib/queue';
import { runJob, step } from '../src/lib/worker-jobs';
import { resetRecordingBreaker } from '../src/lib/worker-health';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const SECRET = 'postgres://worker:HUNTER2-SENTINEL@db.internal:5432/useraid';

suite('worker operator logs carry a code plus safe class only (DEC-2026-11-07-01 d)', () => {
  let lines: string[];
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
  });
  beforeEach(async () => {
    await truncateAll(db);
    await db.$executeRawUnsafe('DELETE FROM "WorkerStepHealth"');
    resetRecordingBreaker();
    lines = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => db.$disconnect());
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  it('a failing step logs the step, a code and a class, not the message', async () => {
    await step('alpha', async () => {
      throw Object.assign(new Error(`insert failed ${SECRET}`), { code: 'P2002' });
    });
    expect(parsed()).toEqual([
      expect.objectContaining({ step: 'alpha', code: 'P2002', errorClass: 'Error' }),
    ]);
    expect(lines.join('\n')).not.toContain('HUNTER2');
    expect(lines.join('\n')).not.toContain('insert failed');
  });

  it('a failing health-store write logs a code and class, not the database message', async () => {
    vi.spyOn(db, '$executeRaw').mockRejectedValue(new Error(`db down ${SECRET}`));
    await step('alpha', async () => {});
    const health = parsed().find((l) => l.step === 'worker-health');
    expect(health).toMatchObject({ code: 'UNCLASSIFIED', errorClass: 'Error' });
    expect(lines.join('\n')).not.toContain('HUNTER2');
  });

  it('a failing job and failed bookkeeping both log a code and class only', async () => {
    await enqueue('collect', 'collect:redact:1', { raidId: 'missing-raid' }, new Date());
    const job = (await claimJob())!;
    vi.spyOn(db, '$transaction').mockRejectedValue(new Error(`bookkeeping ${SECRET}`));
    vi.spyOn(db.raid, 'findUnique').mockRejectedValue(new Error(`collect failed ${SECRET}`));
    vi.spyOn(db.raid, 'findUniqueOrThrow').mockRejectedValue(new Error(`collect failed ${SECRET}`));
    await runJob(job);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of parsed()) {
      expect(line).toMatchObject({ job: job.id, kind: 'collect' });
      expect(line).toHaveProperty('code');
      expect(line).toHaveProperty('errorClass');
      expect(line).not.toHaveProperty('error');
      expect(line).not.toHaveProperty('bookkeepingError');
    }
    expect(lines.join('\n')).not.toContain('HUNTER2');
    expect(lines.join('\n')).not.toContain('collect failed');
  });
});
