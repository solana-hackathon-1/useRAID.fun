import { CommandReceiptError } from '../src/command-receipts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { seedWorkHuman, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { matchesBlockingObservation } from './helpers/lock-observation';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveRaidTerms, publishRaid, readRaidTerms } from '../src/work-loop/storage';
import type { WorkHost, WorkActor } from '../src/work-loop/contracts';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { raidTerms } from './helpers/raid-terms-fixture';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const owner: WorkActor = { accountId: 'synthetic-founder', sessionHash: 'a'.repeat(64) };
const stranger: WorkActor = { accountId: 'stranger', sessionHash: 'b'.repeat(64) };
const host: WorkHost = {
  allowNewWrites: true,
  authorize: async (_tx, actor, guild) =>
    actor.accountId === owner.accountId &&
    actor.sessionHash === owner.sessionHash &&
    guild === 'synthetic-guild',
  reserveSimulatedFunding: async (_tx, b) => 'synthetic:' + b.slotId,
};
const command = (input: unknown, key: string = randomUUID(), actor = owner) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: 'test:' + key,
});
const save = (input: unknown, key?: string, actor = owner, h = host) =>
  runCommandTransaction(db, (tx) => saveRaidTerms(tx, command(input, key, actor), h));
const draft = () => ({
  listingId: null,
  expectedRevision: 0,
  guildId: 'synthetic-guild',
  terms: raidTerms(),
});
const publish = (id: string, version: string, h = host, key?: string) =>
  runCommandTransaction(db, (tx) =>
    publishRaid(tx, command({ listingId: id, termsVersionId: version }, key), h),
  );
const query = async (sql: string, ...args: string[]) =>
  db.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...args);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function backend(tx: Prisma.TransactionClient) {
  return (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;
}
async function observeWait(waiter: number, blocker: number, statement: RegExp) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRawUnsafe<{ query: string; blockers: number[] }[]>(
      'SELECT query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1',
      waiter,
    );
    if (matchesBlockingObservation(rows[0], blocker, statement)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected independent PostgreSQL lock wait was not observed.');
}
const txOptions = { transaction: { timeout: 15000, maxWait: 15000 } };
integration('T016 durable immutable terms and publication', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    await db.user.create({ data: { id: owner.accountId, handle: 'synthetic-founder' } });
  });
  afterAll(() => db.$disconnect());
  it('persists complete immutable versions separately from legacy Raid records', async () => {
    const result = await save(draft());
    expect(result.status).toBe('EXECUTED');
    expect(result.terms).toEqual(raidTerms());
    const [row] = await query(
      'SELECT "revision","state" FROM "WorkListing" WHERE "id"=$1::uuid',
      result.listingId,
    );
    expect(row).toEqual({ revision: 1, state: 'DRAFT' });
    expect(await db.raid.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(1);
    expect(await db.outboxEvent.count()).toBe(1);
  });
  it('rejects raw SQL rewrites and deletion of old terms', async () => {
    const one = await save(draft());
    const two = await save({
      ...draft(),
      listingId: one.listingId,
      expectedRevision: 1,
      terms: { ...raidTerms(), outcome: 'A changed unaccepted draft' },
    });
    expect(two.revision).toBe(2);
    expect(
      await runCommandTransaction(db, (tx) => readRaidTerms(tx, owner, one.termsVersionId, host)),
    ).toMatchObject({ terms: raidTerms() });
    await expect(
      query(
        'UPDATE "TermsVersion" SET "snapshot"=$2::jsonb WHERE "id"=$1::uuid',
        one.termsVersionId,
        JSON.stringify(two.terms),
      ),
    ).rejects.toThrow();
    await expect(
      query('DELETE FROM "TermsVersion" WHERE "id"=$1::uuid', one.termsVersionId),
    ).rejects.toThrow();
  });
  it('rejects malformed base units inserted directly into the database', async () => {
    const one = await save(draft());
    for (const amount of ['1.5', '-1', '18446744073709551616']) {
      const invalid = raidTerms();
      invalid.rewards[0].amount = amount;
      await expect(
        query(
          'INSERT INTO "TermsVersion" ("listingId","revision","snapshot","digest") VALUES ($1::uuid,2,$2::jsonb,$3) RETURNING "id"',
          one.listingId,
          JSON.stringify(invalid),
          '0'.repeat(64),
        ),
      ).rejects.toThrow();
    }
  });
  it('denies foreign, missing scoped authority and disabled new writes, without receipts or data', async () => {
    await expect(save(draft(), undefined, stranger)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(save({ ...draft(), guildId: 'other-guild' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      save(draft(), undefined, owner, { ...host, allowNewWrites: false }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(await db.commandReceipt.count()).toBe(0);
  });
  it('keeps original receipt replay when new writes are off and rejects changed payload', async () => {
    const input = draft(),
      key = randomUUID(),
      one = await save(input, key);
    expect(await save(input, key, owner, { ...host, allowNewWrites: false })).toEqual({
      ...one,
      status: 'REPLAYED',
    });
    await expect(
      save({ ...input, terms: { ...input.terms, title: 'Different intent' } }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      save(input, key, owner, { ...host, authorize: async () => false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('publishes only current complete future terms with an exact simulated slot reservation', async () => {
    const one = await save(draft());
    await expect(
      publish(one.listingId, one.termsVersionId, {
        ...host,
        reserveSimulatedFunding: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    expect(await query('SELECT * FROM "RaidSlot"')).toHaveLength(0);
    const published = await publish(one.listingId, one.termsVersionId);
    const [slot] = await query(
      'SELECT "termsVersionId"::text,"state","fundingMode","fundingRef" FROM "RaidSlot" WHERE "id"=$1::uuid',
      published.slotId,
    );
    expect(slot).toMatchObject({
      termsVersionId: one.termsVersionId,
      state: 'AVAILABLE',
      fundingMode: 'SIMULATED',
      fundingRef: 'synthetic:' + published.slotId,
    });
  });
  it('rejects an OPEN listing without a funded current slot at commit', async () => {
    const one = await save(draft());
    await expect(
      query(
        'UPDATE "WorkListing" SET "state"=\'OPEN\' WHERE "id"=$1::uuid RETURNING "id"',
        one.listingId,
      ),
    ).rejects.toThrow();
  });
  it('rejects stale terms and stale revisions without overwriting history', async () => {
    const one = await save(draft());
    await save({ ...draft(), listingId: one.listingId, expectedRevision: 1 });
    await expect(publish(one.listingId, one.termsVersionId)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(
      save({ ...draft(), listingId: one.listingId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
  it('creates a fresh slot on pre-acceptance amendment and closes the old offer target', async () => {
    const one = await save(draft()),
      published = await publish(one.listingId, one.termsVersionId);
    const two = await save({ ...draft(), listingId: one.listingId, expectedRevision: 1 });
    expect(
      await query('SELECT "state" FROM "RaidSlot" WHERE "id"=$1::uuid', published.slotId),
    ).toEqual([{ state: 'CLOSED' }]);
    const newPublication = await publish(two.listingId, two.termsVersionId);
    expect(newPublication.slotId).not.toBe(published.slotId);
  });
  it('freezes versions after source assignment and rejects privileged raw mutation', async () => {
    const one = await save(draft()),
      published = await publish(one.listingId, one.termsVersionId);
    // The capacity migration forbids phantom FILLED rows; create the real assignment fixture.
    const human = await seedWorkHuman(db, owner.accountId);
    await runCommandTransaction(db, (tx) =>
      commitEngagement(
        tx,
        command(
          { slotId: published.slotId, termsVersionId: one.termsVersionId },
          undefined,
          human.actor,
        ),
        syntheticAcceptanceHost,
      ),
    );
    await expect(
      save({ ...draft(), listingId: one.listingId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'TERMS_FROZEN' });
    await expect(
      query(
        'UPDATE "RaidSlot" SET "termsVersionId"=$2::uuid WHERE "id"=$1::uuid',
        published.slotId,
        randomUUID(),
      ),
    ).rejects.toThrow();
  });
  it('prevents publication of expired or unsupported terms even with owner authority', async () => {
    const one = await save({
      ...draft(),
      terms: {
        ...raidTerms(),
        deadlines: {
          commitment: '2020-01-01T00:00:00.000Z',
          preparation: '2020-01-02T00:00:00.000Z',
          submission: '2020-01-03T00:00:00.000Z',
          review: '2020-01-04T00:00:00.000Z',
          operationalClosure: '2020-01-05T00:00:00.000Z',
        },
      },
    });
    await expect(publish(one.listingId, one.termsVersionId)).rejects.toMatchObject({
      code: 'PUBLICATION_BLOCKED',
    });
  });
  describe('controlled independent PostgreSQL transactions', () => {
    it('serializes two saves and rolls back the stale loser receipt', async () => {
      const one = await save(draft()),
        firstReady = deferred<number>(),
        secondReady = deferred<number>(),
        release = deferred<void>();
      const first = runCommandTransaction(
        db,
        async (port, tx) => {
          const result = await saveRaidTerms(
            port,
            command({ ...draft(), listingId: one.listingId, expectedRevision: 1 }, 'save-first'),
            host,
          );
          firstReady.resolve(await backend(tx));
          await release.promise;
          return result;
        },
        txOptions,
      );
      let second: Promise<unknown> | undefined;
      try {
        const blocker = await firstReady.promise;
        second = runCommandTransaction(
          db,
          async (port, tx) => {
            secondReady.resolve(await backend(tx));
            return saveRaidTerms(
              port,
              command({ ...draft(), listingId: one.listingId, expectedRevision: 1 }, 'save-second'),
              host,
            );
          },
          txOptions,
        );
        const results = Promise.allSettled([first, second]);
        await observeWait(await secondReady.promise, blocker, /WorkListing.*FOR UPDATE/);
        release.resolve();
        const settled = await results;
        expect(settled[0].status).toBe('fulfilled');
        expect(settled[1]).toMatchObject({
          status: 'rejected',
          reason: { code: 'REVISION_CONFLICT' },
        });
        expect(
          await query(
            'SELECT "revision" FROM "TermsVersion" WHERE "listingId"=$1::uuid ORDER BY "revision"',
            one.listingId,
          ),
        ).toEqual([{ revision: 1 }, { revision: 2 }]);
        expect(await db.commandReceipt.count({ where: { idempotencyKey: 'save-second' } })).toBe(0);
      } finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    });
    it.each(['publish-first', 'save-first'] as const)(
      'preserves exact publication/version ordering: %s',
      async (order) => {
        const one = await save(draft()),
          ready = deferred<number>(),
          waiter = deferred<number>(),
          release = deferred<void>();
        const pub = (port: Parameters<typeof publishRaid>[0]) =>
          publishRaid(
            port,
            command(
              { listingId: one.listingId, termsVersionId: one.termsVersionId },
              'ordered-publish',
            ),
            host,
          );
        const amend = (port: Parameters<typeof saveRaidTerms>[0]) =>
          saveRaidTerms(
            port,
            command({ ...draft(), listingId: one.listingId, expectedRevision: 1 }, 'ordered-save'),
            host,
          );
        const first = runCommandTransaction(
          db,
          async (port, tx) => {
            const result = await (order === 'publish-first' ? pub(port) : amend(port));
            ready.resolve(await backend(tx));
            await release.promise;
            return result;
          },
          txOptions,
        );
        let second: Promise<unknown> | undefined;
        try {
          const blocker = await ready.promise;
          second = runCommandTransaction(
            db,
            async (port, tx) => {
              waiter.resolve(await backend(tx));
              return order === 'publish-first' ? amend(port) : pub(port);
            },
            txOptions,
          );
          const results = Promise.allSettled([first, second]);
          await observeWait(await waiter.promise, blocker, /WorkListing.*FOR UPDATE/);
          release.resolve();
          const settled = await results;
          expect(settled[0].status).toBe('fulfilled');
          if (order === 'save-first')
            expect(settled[1]).toMatchObject({
              status: 'rejected',
              reason: { code: 'REVISION_CONFLICT' },
            });
          else expect(settled[1].status).toBe('fulfilled');
          const [source] = await query(
            'SELECT "revision","state" FROM "WorkListing" WHERE "id"=$1::uuid',
            one.listingId,
          );
          expect(source).toEqual({ revision: 2, state: 'DRAFT' });
          const slots = await query(
            'SELECT "state" FROM "RaidSlot" WHERE "listingId"=$1::uuid',
            one.listingId,
          );
          expect(slots).toEqual(order === 'publish-first' ? [{ state: 'CLOSED' }] : []);
          expect(
            await db.commandReceipt.count({ where: { idempotencyKey: 'ordered-publish' } }),
          ).toBe(order === 'publish-first' ? 1 : 0);
        } finally {
          release.resolve();
          await Promise.allSettled([first, ...(second ? [second] : [])]);
        }
      },
    );
    it('serializes distinct publish commands into one slot and one reservation', async () => {
      const one = await save(draft()),
        ready = deferred<number>(),
        waiter = deferred<number>(),
        release = deferred<void>();
      let reservations = 0;
      const counted = {
        ...host,
        reserveSimulatedFunding: async (
          tx: Parameters<WorkHost['reserveSimulatedFunding']>[0],
          binding: Parameters<WorkHost['reserveSimulatedFunding']>[1],
        ) => {
          reservations++;
          return host.reserveSimulatedFunding(tx, binding);
        },
      };
      const pub = (port: Parameters<typeof publishRaid>[0], key: string) =>
        publishRaid(
          port,
          command({ listingId: one.listingId, termsVersionId: one.termsVersionId }, key),
          counted,
        );
      const first = runCommandTransaction(
        db,
        async (port, tx) => {
          const result = await pub(port, 'publish-first');
          ready.resolve(await backend(tx));
          await release.promise;
          return result;
        },
        txOptions,
      );
      let second: Promise<unknown> | undefined;
      try {
        const blocker = await ready.promise;
        second = runCommandTransaction(
          db,
          async (port, tx) => {
            waiter.resolve(await backend(tx));
            return pub(port, 'publish-second');
          },
          txOptions,
        );
        const results = Promise.allSettled([first, second]);
        await observeWait(await waiter.promise, blocker, /WorkListing.*FOR UPDATE/);
        release.resolve();
        const settled = await results;
        expect(settled.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(
          await query('SELECT "state" FROM "RaidSlot" WHERE "listingId"=$1::uuid', one.listingId),
        ).toEqual([{ state: 'AVAILABLE' }]);
        expect(reservations).toBe(1);
        expect(await db.commandReceipt.count({ where: { commandKind: 'PublishRaid' } })).toBe(2);
      } finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    });
    it('retries the whole publication transaction with its original command identity', async () => {
      const one = await save(draft());
      const c = command(
        { listingId: one.listingId, termsVersionId: one.termsVersionId },
        'retry-publication',
      );
      let attempts = 0;
      const published = await runCommandTransaction(db, async (port) => {
        attempts++;
        const result = await publishRaid(port, c, host);
        if (attempts === 1) throw new CommandReceiptError('RETRY_TRANSACTION');
        return result;
      });
      expect(attempts).toBe(2);
      expect(published.status).toBe('EXECUTED');
      expect(
        await query('SELECT "id"::text FROM "RaidSlot" WHERE "listingId"=$1::uuid', one.listingId),
      ).toEqual([{ id: published.slotId }]);
      expect(
        await db.commandReceipt.count({ where: { idempotencyKey: 'retry-publication' } }),
      ).toBe(1);
      expect(await db.auditEvent.count({ where: { eventType: 'work.raid_published.v1' } })).toBe(1);
      expect(await db.outboxEvent.count()).toBe(2); // original terms + the single committed publication
    });
    it('rechecks revoked current authority after waiting and commits no publication receipt', async () => {
      const one = await save(draft()),
        ready = deferred<number>(),
        waiter = deferred<number>(),
        release = deferred<void>();
      const currentHost: WorkHost = {
        ...host,
        authorize: async (tx, a, g) => {
          if (!(await host.authorize(tx, a, g, 'MANAGE_LISTING'))) return false;
          const rows = await tx.query<{ suspended: boolean }>(
            'SELECT "suspended" FROM "User" WHERE "id"=$1 FOR SHARE',
            [a.accountId],
          );
          return rows.length === 1 && !rows[0].suspended;
        },
      };
      const revoker = db.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            'SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE',
            owner.accountId,
          );
          await tx.user.update({ where: { id: owner.accountId }, data: { suspended: true } });
          ready.resolve(await backend(tx));
          await release.promise;
        },
        { timeout: 15000 },
      );
      let publisher: Promise<unknown> | undefined;
      try {
        const blocker = await ready.promise;
        publisher = runCommandTransaction(
          db,
          async (port, tx) => {
            waiter.resolve(await backend(tx));
            return publishRaid(
              port,
              command(
                { listingId: one.listingId, termsVersionId: one.termsVersionId },
                'revoked-publish',
              ),
              currentHost,
            );
          },
          txOptions,
        );
        const results = Promise.allSettled([revoker, publisher]);
        await observeWait(await waiter.promise, blocker, /User.*FOR SHARE/);
        release.resolve();
        const settled = await results;
        expect(settled[0].status).toBe('fulfilled');
        expect(settled[1]).toMatchObject({ status: 'rejected', reason: { code: 'FORBIDDEN' } });
        expect(await query('SELECT "id" FROM "RaidSlot"')).toHaveLength(0);
        expect(
          await db.commandReceipt.count({ where: { idempotencyKey: 'revoked-publish' } }),
        ).toBe(0);
        expect(
          await query('SELECT "state" FROM "WorkListing" WHERE "id"=$1::uuid', one.listingId),
        ).toEqual([{ state: 'DRAFT' }]);
      } finally {
        release.resolve();
        await Promise.allSettled([revoker, ...(publisher ? [publisher] : [])]);
      }
    });
  });
});
