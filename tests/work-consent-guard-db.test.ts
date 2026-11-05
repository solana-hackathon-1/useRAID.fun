import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { recordAcceptanceConsent } from '../src/work-loop/consent-storage';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import {
  seedWorkHuman,
  seedWorkSlot,
  syntheticAcceptanceHost as host,
} from './helpers/work-loop-db';
import { matchesBlockingObservation } from './helpers/lock-observation';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const txOptions = { transaction: { timeout: 15000, maxWait: 15000 } };
const rows = <T>(sql: string, ...args: string[]) => db.$queryRawUnsafe<T[]>(sql, ...args);
type Human = Awaited<ReturnType<typeof seedWorkHuman>>;
type Slot = Awaited<ReturnType<typeof seedWorkSlot>>;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
/** SQLSTATE of a raw-query failure: Prisma wraps the driver's code in `meta.code` for raw statements. */
function sqlState(error: unknown) {
  const source = error as { code?: string; meta?: { code?: string } };
  return source.code === 'P2010' ? source.meta?.code : source.code;
}
const digestOf = async (slot: Slot) =>
  (
    await rows<{ digest: string }>(
      'SELECT "digest" FROM "TermsVersion" WHERE "id"=$1::uuid',
      slot.termsVersionId,
    )
  )[0].digest;
const consentCount = async () =>
  (await rows<{ n: number }>('SELECT count(*)::int AS n FROM "WorkAcceptanceConsent"'))[0].n;
const INSERT =
  'INSERT INTO "WorkAcceptanceConsent" ("participantId","slotId","termsVersionId","termsDigest") VALUES ($1::uuid,$2::uuid,$3::uuid,$4)';
const consent = async (human: Human, slot: Slot) => {
  const key = randomUUID(),
    termsDigest = await digestOf(slot);
  return runCommandTransaction(
    db,
    (tx) =>
      recordAcceptanceConsent(
        tx,
        {
          actor: human.actor,
          input: { slotId: slot.slotId, termsVersionId: slot.termsVersionId, termsDigest },
          idempotencyKey: key,
          requestId: 'test:' + key,
        },
        { allowNewWrites: true },
      ),
    txOptions,
  );
};
const accept = (human: Human, slot: Slot, h = host) => {
  const key = randomUUID();
  return runCommandTransaction(
    db,
    (tx) =>
      commitEngagement(
        tx,
        {
          actor: human.actor,
          input: { slotId: slot.slotId, termsVersionId: slot.termsVersionId },
          idempotencyKey: key,
          requestId: 'test:' + key,
        },
        h,
      ),
    txOptions,
  );
};
async function waitFor(blocker: number, statement: RegExp) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const waiting = await rows<{ query: string; blockers: number[] }>(
      `SELECT query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`,
    );
    if (waiting.some((row) => matchesBlockingObservation(row, blocker, statement))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected database blocking relationship was not observed.');
}
integration('Consent insert guard (#275 item 3)', { timeout: 60000 }, () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());

  it('rejects a mismatched slot and terms-version pair with a foreign-key violation, not no_data_found', async () => {
    const slot = await seedWorkSlot(db),
      other = await seedWorkSlot(db),
      person = await seedWorkHuman(db);
    const attempt = (slotId: string, termsVersionId: string) =>
      db
        .$executeRawUnsafe(INSERT, person.participantId, slotId, termsVersionId, 'a'.repeat(64))
        .then(
          () => 'inserted',
          (error) => sqlState(error),
        );
    // Another slot's terms version, and a slot that does not exist at all.
    expect(await attempt(slot.slotId, other.termsVersionId)).toBe('23503');
    expect(await attempt(randomUUID(), slot.termsVersionId)).toBe('23503');
    expect(await consentCount()).toBe(0);
  });

  it('holds the listing and slot against a concurrent fill until the consent transaction ends', async () => {
    const slot = await seedWorkSlot(db),
      consenter = await seedWorkHuman(db),
      taker = await seedWorkHuman(db),
      digest = await digestOf(slot);
    const inserted = deferred(),
      release = deferred(),
      holder = deferred<number>();
    const open = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        INSERT,
        consenter.participantId,
        slot.slotId,
        slot.termsVersionId,
        digest,
      );
      holder.resolve(
        (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid,
      );
      inserted.resolve();
      await release.promise;
    }, txOptions.transaction);
    await inserted.promise;
    let filled = false;
    const fill = accept(taker, slot).then((result) => ((filled = true), result));
    // The fill must queue behind the uncommitted consent's lock instead of committing around it.
    await waitFor(await holder.promise, /FOR UPDATE/);
    expect(filled).toBe(false);
    release.resolve();
    await open;
    await fill;
    expect(await consentCount()).toBe(1);
    const [row] = await rows<{ state: string }>(
      'SELECT "state" FROM "RaidSlot" WHERE "id"=$1::uuid',
      slot.slotId,
    );
    expect(row.state).toBe('FILLED');
  });

  it('makes a direct consent insert wait for an in-flight fill and then refuse the filled slot', async () => {
    const slot = await seedWorkSlot(db),
      consenter = await seedWorkHuman(db),
      taker = await seedWorkHuman(db);
    const holding = deferred<number>(),
      release = deferred();
    const gated: typeof host = {
      ...host,
      fundingAvailable: async (...args) => {
        const [row] = await args[0].query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
        holding.resolve(row.pid);
        await release.promise;
        return host.fundingAvailable(...args);
      },
    };
    const fill = accept(taker, slot, gated);
    const blocker = await holding.promise;
    // The fill is uncommitted, so the guard's own read still sees the slot open; only its lock can make it wait.
    const direct = db
      .$executeRawUnsafe(
        INSERT,
        consenter.participantId,
        slot.slotId,
        slot.termsVersionId,
        await digestOf(slot),
      )
      .then(
        () => 'inserted',
        (error) => sqlState(error),
      );
    await waitFor(blocker, /INSERT INTO "WorkAcceptanceConsent"/);
    release.resolve();
    await fill;
    expect(await direct).toBe('23514');
    expect(await consentCount()).toBe(0);
  });

  it('serializes a consent behind an in-flight fill and refuses it cleanly once the slot is filled', async () => {
    const slot = await seedWorkSlot(db),
      consenter = await seedWorkHuman(db),
      taker = await seedWorkHuman(db);
    const holding = deferred<number>(),
      release = deferred();
    const gated: typeof host = {
      ...host,
      fundingAvailable: async (...args) => {
        const [row] = await args[0].query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
        holding.resolve(row.pid);
        await release.promise;
        return host.fundingAvailable(...args);
      },
    };
    const fill = accept(taker, slot, gated);
    const blocker = await holding.promise;
    let settled = false;
    const late = consent(consenter, slot).finally(() => (settled = true));
    late.catch(() => undefined);
    await waitFor(blocker, /FOR SHARE/);
    expect(settled).toBe(false);
    release.resolve();
    await fill;
    await expect(late).rejects.toMatchObject({ code: 'SLOT_FILLED' });
    expect(await consentCount()).toBe(0);
  });
});
