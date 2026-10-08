import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  CommandReceiptError,
  canonicalRequestDigest,
  executeIdempotentCommand,
  processInboundDelivery,
  type CommandInput,
  type CommandOutcome,
  type DomainEventInput,
} from '../src/command-receipts';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
function client() {
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/invalid');
  url.searchParams.set('connection_limit', '24');
  return new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
}
const db = client();
const TX = { timeout: 30_000, maxWait: 30_000 };
const BUSINESS = 'synthetic.t019';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function pid(tx: Prisma.TransactionClient) {
  return (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;
}
async function observeBlock(waiter: number, blocker: number, statement: RegExp) {
  expect(waiter).not.toBe(blocker);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRawUnsafe<{ query: string; blockers: number[] }[]>(
      'SELECT query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1',
      waiter,
    );
    if (rows[0]?.blockers.includes(blocker)) {
      expect(rows[0].query).toMatch(statement);
      // Evidence comes from the database lock graph, never from elapsed sleep.
      console.info(
        JSON.stringify({ receiptRace: true, waiter, blocker, blockedStatement: rows[0].query }),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected independent PostgreSQL blocker was not observed');
}
const command = (patch: Partial<CommandInput> = {}): CommandInput => ({
  actorId: 'account-a',
  commandKind: 'CommitEngagement',
  idempotencyKey: 'key-1',
  requestId: 'request-1',
  request: { slot: 'slot-1', expectedTermsVersion: 'terms-v1', note: 'SECRET-PRIVATE-BRIEF' },
  ...patch,
});
const event = (patch: Partial<DomainEventInput> = {}): DomainEventInput => ({
  type: 'work.engagement_committed.v1',
  aggregateId: 'engagement-1',
  aggregateVersion: 1,
  guildId: 'guild-1',
  payload: { termsVersionId: 'terms-v1' },
  ...patch,
});
type Behaviour = {
  beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
  events?: DomainEventInput[];
  resultRef?: string;
  runs?: { count: number };
};
function exec(cmd: CommandInput, behaviour: Behaviour = {}) {
  return runCommandTransaction(
    db,
    (port, tx) =>
      executeIdempotentCommand(port, cmd, async () => {
        if (behaviour.runs) behaviour.runs.count++;
        await tx.event.create({ data: { type: BUSINESS, visitor: cmd.idempotencyKey } });
        await behaviour.beforeCommit?.(tx);
        return {
          resultRef: behaviour.resultRef ?? `result-${cmd.idempotencyKey}`,
          events: behaviour.events ?? [event()],
        } satisfies CommandOutcome;
      }),
    { transaction: TX },
  );
}
const businessRows = () => db.event.count({ where: { type: BUSINESS } });
const counts = async () => ({
  business: await businessRows(),
  receipts: await db.commandReceipt.count(),
  audit: await db.auditEvent.count(),
  outbox: await db.outboxEvent.count(),
  inbox: await db.inboxDelivery.count(),
});
async function snapshot() {
  return JSON.stringify([
    await db.$queryRawUnsafe('SELECT * FROM "CommandReceipt" ORDER BY "id"'),
    await db.$queryRawUnsafe('SELECT * FROM "AuditEvent" ORDER BY "id"'),
    await db.$queryRawUnsafe('SELECT * FROM "OutboxEvent" ORDER BY "id"'),
    await db.$queryRawUnsafe('SELECT * FROM "InboxDelivery" ORDER BY "id"'),
  ]);
}
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e as { code?: string; message?: string },
  );

integration('command receipts on real PostgreSQL', { timeout: 30_000 }, () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(() => truncateAll(db));
  afterAll(() => db.$disconnect());

  describe('one logical command, one outcome', () => {
    it('commits the business row, receipt, audit and outbox together and replays the original', async () => {
      const runs = { count: 0 };
      const first = await exec(command(), { runs });
      expect(first.status).toBe('EXECUTED');
      expect(first.resultRef).toBe('result-key-1');
      expect(await counts()).toEqual({
        business: 1,
        receipts: 1,
        audit: 1,
        outbox: 1,
        inbox: 0,
      });
      const [receipt] = await db.commandReceipt.findMany();
      expect(receipt).toMatchObject({
        id: first.receiptId,
        actorId: 'account-a',
        commandKind: 'CommitEngagement',
        idempotencyKey: 'key-1',
        requestId: 'request-1',
        resultRef: 'result-key-1',
        requestDigest: canonicalRequestDigest(command().request),
      });
      const [audit] = await db.auditEvent.findMany();
      expect(audit).toMatchObject({
        receiptId: receipt.id,
        inboxId: null,
        ordinal: 0,
        eventType: 'work.engagement_committed.v1',
        aggregateId: 'engagement-1',
        aggregateVersion: 1,
        actorId: 'account-a',
        guildId: 'guild-1',
        correlationId: 'request-1',
        payload: { termsVersionId: 'terms-v1' },
      });
      expect((await db.outboxEvent.findMany())[0].eventId).toBe(audit.id);

      const before = await snapshot();
      const replay = await exec(command({ requestId: 'request-retry' }), { runs });
      expect(replay).toEqual({
        status: 'REPLAYED',
        receiptId: first.receiptId,
        resultRef: 'result-key-1',
      });
      expect(runs.count).toBe(1);
      expect(await snapshot()).toBe(before);
    });

    it('conflicts on the same key with a different payload and never overwrites the original', async () => {
      await exec(command());
      const before = await snapshot();
      for (const request of [
        { slot: 'slot-2', expectedTermsVersion: 'terms-v1', note: 'SECRET-PRIVATE-BRIEF' },
        { slot: 'slot-1', expectedTermsVersion: 'terms-v2', note: 'SECRET-PRIVATE-BRIEF' },
      ]) {
        const runs = { count: 0 };
        const error = await failure(exec(command({ request }), { runs }));
        expect(error).toBeInstanceOf(CommandReceiptError);
        expect(error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(runs.count).toBe(0);
      }
      expect(await snapshot()).toBe(before);
      expect(await businessRows()).toBe(1);
    });

    it('scopes the key to actor and command kind', async () => {
      const results = await Promise.all([
        exec(command()),
        exec(command({ actorId: 'account-b' })),
        exec(command({ commandKind: 'StartEngagement' })),
      ]);
      expect(results.map((r) => r.status)).toEqual(['EXECUTED', 'EXECUTED', 'EXECUTED']);
      expect(new Set(results.map((r) => r.receiptId)).size).toBe(3);
      expect((await counts()).receipts).toBe(3);
    });

    it('records several events with ordinals and only publishes the marked ones', async () => {
      await exec(command(), {
        events: [
          event(),
          event({ aggregateVersion: 2, publish: false, type: 'work.engagement_audited_only.v1' }),
          event({ aggregateVersion: 3, type: 'work.engagement_notified.v1' }),
        ],
      });
      const audit = await db.auditEvent.findMany({ orderBy: { ordinal: 'asc' } });
      expect(audit.map((a) => a.ordinal)).toEqual([0, 1, 2]);
      const published = (await db.outboxEvent.findMany()).map((o) => o.eventId).sort();
      expect(published).toEqual([audit[0].id, audit[2].id].sort());
    });
  });

  describe('atomic commit', () => {
    it.each([
      [
        'callback error',
        {
          beforeCommit: async () => {
            throw Error('domain rejection');
          },
        },
      ],
      ['invalid event payload', { events: [event({ payload: { note: 'SECRET' } })] }],
      ['no event', { events: [] }],
      ['invalid result reference', { resultRef: 'has space' }],
    ] as [string, Behaviour][])(
      'persists nothing on %s and lets the same key execute later',
      async (_name, behaviour) => {
        expect(await failure(exec(command(), behaviour))).toBeDefined();
        expect(await counts()).toEqual({
          business: 0,
          receipts: 0,
          audit: 0,
          outbox: 0,
          inbox: 0,
        });
        expect((await exec(command())).status).toBe('EXECUTED');
        expect(await counts()).toMatchObject({ business: 1, receipts: 1, audit: 1, outbox: 1 });
      },
    );

    it('rolls the business row back when a later database statement fails', async () => {
      // A database-level failure after the business write must undo that write (dangling outbox FK).
      const error = await failure(
        exec(command(), {
          beforeCommit: async (tx) => {
            await tx.$executeRawUnsafe(
              'INSERT INTO "OutboxEvent" ("eventId") VALUES (gen_random_uuid())',
            );
          },
        }),
      );
      expect(error).toBeDefined();
      expect(await counts()).toMatchObject({ business: 0, receipts: 0, audit: 0, outbox: 0 });
    });
  });

  describe('competing real transactions', () => {
    it('blocks the second identical command on the first backend, then replays it', async () => {
      const gate = deferred();
      const firstStarted = deferred<number>();
      const secondPid = deferred<number>();
      const runs = { a: 0, b: 0 };
      const a = runCommandTransaction(
        db,
        (port, tx) =>
          executeIdempotentCommand(port, command(), async () => {
            runs.a++;
            firstStarted.resolve(await pid(tx));
            await gate.promise;
            await tx.event.create({ data: { type: BUSINESS } });
            return { resultRef: 'result-1', events: [event()] };
          }),
        { transaction: TX },
      );
      const blocker = await firstStarted.promise;
      const b = runCommandTransaction(
        db,
        async (port, tx) => {
          secondPid.resolve(await pid(tx));
          return executeIdempotentCommand(port, command({ requestId: 'request-2' }), async () => {
            runs.b++;
            await tx.event.create({ data: { type: BUSINESS } });
            return { resultRef: 'result-2', events: [event()] };
          });
        },
        { transaction: TX },
      );
      await observeBlock(await secondPid.promise, blocker, /INSERT INTO "CommandReceipt"/);
      gate.resolve();
      const [first, second] = await Promise.all([a, b]);
      expect(first.status).toBe('EXECUTED');
      expect(second).toEqual({
        status: 'REPLAYED',
        receiptId: first.receiptId,
        resultRef: 'result-1',
      });
      expect(runs).toEqual({ a: 1, b: 0 });
      expect(await counts()).toMatchObject({ business: 1, receipts: 1, audit: 1, outbox: 1 });
    });

    it('lets the waiting command execute when the first one rolls back', async () => {
      const gate = deferred();
      const firstStarted = deferred<number>();
      const secondPid = deferred<number>();
      const a = failure(
        runCommandTransaction(
          db,
          (port, tx) =>
            executeIdempotentCommand(port, command(), async () => {
              firstStarted.resolve(await pid(tx));
              await gate.promise;
              throw Error('domain rejection');
            }),
          { transaction: TX },
        ),
      );
      const blocker = await firstStarted.promise;
      const runs = { count: 0 };
      const b = runCommandTransaction(
        db,
        async (port, tx) => {
          secondPid.resolve(await pid(tx));
          return executeIdempotentCommand(port, command(), async () => {
            runs.count++;
            await tx.event.create({ data: { type: BUSINESS } });
            return { resultRef: 'result-b', events: [event()] };
          });
        },
        { transaction: TX },
      );
      await observeBlock(await secondPid.promise, blocker, /INSERT INTO "CommandReceipt"/);
      gate.resolve();
      expect((await a)?.message).toBe('domain rejection');
      expect((await b).status).toBe('EXECUTED');
      expect(runs.count).toBe(1);
      expect(await counts()).toMatchObject({ business: 1, receipts: 1, audit: 1, outbox: 1 });
    });

    it('reports a conflict, not a replay, when the waiting command has another payload', async () => {
      const gate = deferred();
      const firstStarted = deferred<number>();
      const secondPid = deferred<number>();
      const a = runCommandTransaction(
        db,
        (port, tx) =>
          executeIdempotentCommand(port, command(), async () => {
            firstStarted.resolve(await pid(tx));
            await gate.promise;
            return { resultRef: 'result-1', events: [event()] };
          }),
        { transaction: TX },
      );
      const blocker = await firstStarted.promise;
      const b = failure(
        runCommandTransaction(
          db,
          async (port, tx) => {
            secondPid.resolve(await pid(tx));
            return executeIdempotentCommand(
              port,
              command({ request: { slot: 'slot-9' } }),
              async () => ({ resultRef: 'result-x', events: [event()] }),
            );
          },
          { transaction: TX },
        ),
      );
      await observeBlock(await secondPid.promise, blocker, /INSERT INTO "CommandReceipt"/);
      gate.resolve();
      await a;
      expect((await b)?.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await counts()).toMatchObject({ receipts: 1, audit: 1, outbox: 1 });
      expect((await db.commandReceipt.findMany())[0].resultRef).toBe('result-1');
    });

    it('produces one execution for eight simultaneous identical commands', async () => {
      const runs = { count: 0 };
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => exec(command({ requestId: `request-${i}` }), { runs })),
      );
      expect(results.filter((r) => r.status === 'EXECUTED')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'REPLAYED')).toHaveLength(7);
      expect(new Set(results.map((r) => r.receiptId)).size).toBe(1);
      expect(new Set(results.map((r) => r.resultRef)).size).toBe(1);
      expect(runs.count).toBe(1);
      expect(await counts()).toMatchObject({ business: 1, receipts: 1, audit: 1, outbox: 1 });
    });
  });

  describe('whole-transaction retry keeps the semantic identity', () => {
    const synthetic40001 = (tx: Prisma.TransactionClient) =>
      tx.$executeRawUnsafe(
        `DO $$ BEGIN RAISE EXCEPTION 'synthetic serialization failure' USING ERRCODE = '40001'; END $$`,
      );
    it('re-runs the entire transaction after a serialization failure and commits one outcome', async () => {
      const runs = { count: 0 };
      const keys: string[] = [];
      const result = await runCommandTransaction(
        db,
        (port, tx) => {
          const cmd = command();
          keys.push(`${cmd.actorId}:${cmd.commandKind}:${cmd.idempotencyKey}`);
          return executeIdempotentCommand(port, cmd, async () => {
            runs.count++;
            await tx.event.create({ data: { type: BUSINESS } });
            if (runs.count === 1) await synthetic40001(tx);
            return { resultRef: 'result-1', events: [event()] };
          });
        },
        { transaction: TX },
      );
      expect(result.status).toBe('EXECUTED');
      expect(runs.count).toBe(2);
      expect(new Set(keys).size).toBe(1);
      expect(await counts()).toMatchObject({ business: 1, receipts: 1, audit: 1, outbox: 1 });
    });

    it('classifies exhaustion as RETRY_TRANSACTION and persists nothing', async () => {
      const runs = { count: 0 };
      const error = await failure(
        runCommandTransaction(
          db,
          (port, tx) =>
            executeIdempotentCommand(port, command(), async () => {
              runs.count++;
              await tx.event.create({ data: { type: BUSINESS } });
              await synthetic40001(tx);
              return { resultRef: 'never', events: [event()] };
            }),
          { transaction: TX, maxAttempts: 2 },
        ),
      );
      expect(error).toBeInstanceOf(CommandReceiptError);
      expect(error?.code).toBe('RETRY_TRANSACTION');
      expect(runs.count).toBe(2);
      expect(await counts()).toMatchObject({ business: 0, receipts: 0, audit: 0, outbox: 0 });
    });

    it('survives a genuine PostgreSQL deadlock between two different commands', async () => {
      let arrived = 0;
      const both = deferred();
      const arrive = () => {
        if (++arrived >= 2) both.resolve();
        return both.promise;
      };
      const lockErrors: string[] = [];
      const runs = { count: 0 };
      const lock = (tx: Prisma.TransactionClient, id: number) =>
        tx
          .$queryRawUnsafe(`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(${id})) AS locked`)
          .catch((e: { meta?: { code?: string } }) => {
            lockErrors.push(String(e.meta?.code));
            throw e;
          });
      const contender = (key: string, first: number, second: number) =>
        runCommandTransaction(
          db,
          (port, tx) =>
            executeIdempotentCommand(port, command({ idempotencyKey: key }), async () => {
              runs.count++;
              await tx.event.create({ data: { type: BUSINESS, visitor: key } });
              await lock(tx, first);
              await arrive();
              await lock(tx, second);
              return { resultRef: `result-${key}`, events: [event({ aggregateId: key })] };
            }),
          { transaction: TX, maxAttempts: 3 },
        );
      const [x, y] = await Promise.all([
        contender('key-x', 9101, 9102),
        contender('key-y', 9102, 9101),
      ]);
      expect([x.status, y.status]).toEqual(['EXECUTED', 'EXECUTED']);
      expect(lockErrors).toEqual(['40P01']);
      expect(runs.count).toBe(3);
      expect(await counts()).toMatchObject({ business: 2, receipts: 2, audit: 2, outbox: 2 });
      expect(
        (await db.commandReceipt.findMany({ orderBy: { idempotencyKey: 'asc' } })).map(
          (r) => r.resultRef,
        ),
      ).toEqual(['result-key-x', 'result-key-y']);
    }, 40_000);
  });

  describe('inbound provider deliveries (AC32 foundation)', () => {
    const delivery = (patch: Record<string, unknown> = {}) => ({
      provider: 'chain-watcher',
      verifiedDeliveryId: 'delivery-1',
      payload: { claim: 'claim-1', amount: '1000000', secret: 'SECRET-WEBHOOK-BODY' },
      ...patch,
    });
    const deliver = (input = delivery(), runs = { count: 0 }, fail = false) =>
      runCommandTransaction(
        db,
        (port, tx) =>
          processInboundDelivery(port, input, async () => {
            runs.count++;
            await tx.event.create({ data: { type: `${BUSINESS}.delivery` } });
            if (fail) throw Error('handler failed');
            return {
              resultRef: 'claim-1',
              events: [event({ type: 'treasury.claim_paid.v1', payload: { claimId: 'claim-1' } })],
            };
          }),
        { transaction: TX },
      );
    const deliveryBusiness = () => db.event.count({ where: { type: `${BUSINESS}.delivery` } });

    it('runs the handler once for a repeated delivery and stores only the digest', async () => {
      const runs = { count: 0 };
      const first = await deliver(delivery(), runs);
      expect(first.status).toBe('PROCESSED');
      const second = await deliver(delivery(), runs);
      expect(second).toEqual({
        status: 'DUPLICATE',
        deliveryRecordId: first.deliveryRecordId,
        resultRef: 'claim-1',
      });
      expect(runs.count).toBe(1);
      expect(await deliveryBusiness()).toBe(1);
      const [row] = await db.inboxDelivery.findMany();
      expect(row).toMatchObject({
        provider: 'chain-watcher',
        deliveryId: 'delivery-1',
        resultRef: 'claim-1',
        payloadDigest: canonicalRequestDigest(delivery().payload),
      });
      const [audit] = await db.auditEvent.findMany();
      expect(audit).toMatchObject({
        inboxId: row.id,
        receiptId: null,
        actorId: 'provider:chain-watcher',
        correlationId: 'delivery:chain-watcher:delivery-1',
      });
      expect(await db.outboxEvent.count()).toBe(1);
    });

    it('yields one outcome for eight simultaneous deliveries', async () => {
      const runs = { count: 0 };
      const results = await Promise.all(Array.from({ length: 8 }, () => deliver(delivery(), runs)));
      expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'DUPLICATE')).toHaveLength(7);
      expect(runs.count).toBe(1);
      expect(await deliveryBusiness()).toBe(1);
      expect(await counts()).toMatchObject({ inbox: 1, audit: 1, outbox: 1 });
    });

    it('blocks the duplicate on the first backend while the first handler is open', async () => {
      const gate = deferred();
      const firstPid = deferred<number>();
      const secondPid = deferred<number>();
      const first = runCommandTransaction(
        db,
        (port, tx) =>
          processInboundDelivery(port, delivery(), async () => {
            firstPid.resolve(await pid(tx));
            await gate.promise;
            await tx.event.create({ data: { type: `${BUSINESS}.delivery` } });
            return { resultRef: 'claim-1', events: [event()] };
          }),
        { transaction: TX },
      );
      const blocker = await firstPid.promise;
      const runs = { count: 0 };
      const second = runCommandTransaction(
        db,
        async (port, tx) => {
          secondPid.resolve(await pid(tx));
          return processInboundDelivery(port, delivery(), async () => {
            runs.count++;
            return { resultRef: 'never', events: [event()] };
          });
        },
        { transaction: TX },
      );
      await observeBlock(await secondPid.promise, blocker, /INSERT INTO "InboxDelivery"/);
      gate.resolve();
      expect((await first).status).toBe('PROCESSED');
      expect((await second).status).toBe('DUPLICATE');
      expect(runs.count).toBe(0);
      expect(await deliveryBusiness()).toBe(1);
    });

    it('conflicts on a changed payload, keeps the original and separates providers', async () => {
      await deliver();
      const before = await snapshot();
      const error = await failure(deliver(delivery({ payload: { claim: 'claim-2' } })));
      expect(error?.code).toBe('DELIVERY_PAYLOAD_CONFLICT');
      expect(await snapshot()).toBe(before);
      const other = await deliver(delivery({ provider: 'other-watcher' }));
      expect(other.status).toBe('PROCESSED');
      expect((await counts()).inbox).toBe(2);
    });

    it('releases the claim when the handler fails so a redelivery can succeed', async () => {
      expect(await failure(deliver(delivery(), { count: 0 }, true))).toBeDefined();
      expect(await counts()).toMatchObject({ inbox: 0, audit: 0, outbox: 0 });
      expect(await deliveryBusiness()).toBe(0);
      expect((await deliver()).status).toBe('PROCESSED');
      expect(await deliveryBusiness()).toBe(1);
    });
  });

  describe('private data stays out of the tables (I06)', () => {
    it('stores identifiers and digests only', async () => {
      await exec(command());
      await runCommandTransaction(
        db,
        (port) =>
          processInboundDelivery(
            port,
            {
              provider: 'chain-watcher',
              verifiedDeliveryId: 'delivery-9',
              payload: { secret: 'SECRET-WEBHOOK-BODY' },
            },
            async () => ({ resultRef: 'claim-9', events: [event()] }),
          ),
        { transaction: TX },
      );
      const dump = JSON.stringify([
        await db.$queryRawUnsafe('SELECT * FROM "CommandReceipt"'),
        await db.$queryRawUnsafe('SELECT * FROM "InboxDelivery"'),
        await db.$queryRawUnsafe('SELECT * FROM "AuditEvent"'),
        await db.$queryRawUnsafe('SELECT * FROM "OutboxEvent"'),
      ]);
      expect(dump).not.toContain('SECRET-PRIVATE-BRIEF');
      expect(dump).not.toContain('SECRET-WEBHOOK-BODY');
    });
  });

  describe('database guards', () => {
    const insertReceipt = (key = 'k1', result: string | null = 'result-1') =>
      `INSERT INTO "CommandReceipt" ("actorId","commandKind","idempotencyKey","requestDigest","requestId","resultRef")
       VALUES ('account-a','CommitEngagement','${key}','${'a'.repeat(64)}','request-1',${result === null ? 'NULL' : `'${result}'`})`;
    const rejected = async (sql: string, pattern: RegExp) => {
      const error = await failure(db.$executeRawUnsafe(sql));
      expect(error?.message ?? '').toMatch(pattern);
    };
    async function seed() {
      const result = await exec(command());
      return {
        receiptId: result.receiptId,
        auditId: (await db.auditEvent.findFirstOrThrow()).id,
        outboxId: (await db.outboxEvent.findFirstOrThrow()).id,
      };
    }

    it('keeps receipts immutable and unique per actor, kind and key', async () => {
      const { receiptId } = await seed();
      await rejected(
        `UPDATE "CommandReceipt" SET "requestDigest" = '${'b'.repeat(64)}' WHERE id = '${receiptId}'`,
        /immutable/i,
      );
      await rejected(
        `UPDATE "CommandReceipt" SET "resultRef" = 'other' WHERE id = '${receiptId}'`,
        /immutable/i,
      );
      await rejected(
        `DELETE FROM "CommandReceipt" WHERE id = '${receiptId}'`,
        /retention|immutable/i,
      );
      await rejected(insertReceipt('key-1'), /already exists|unique|duplicate/i);
    });

    it('keeps audit and outbox rows append-only', async () => {
      const { auditId, outboxId } = await seed();
      await rejected(
        `UPDATE "AuditEvent" SET "aggregateId" = 'x' WHERE id = '${auditId}'`,
        /append-only/i,
      );
      await rejected(`DELETE FROM "AuditEvent" WHERE id = '${auditId}'`, /append-only/i);
      await rejected(
        `UPDATE "OutboxEvent" SET "createdAt" = now() WHERE id = '${outboxId}'`,
        /append-only/i,
      );
      await rejected(`DELETE FROM "OutboxEvent" WHERE id = '${outboxId}'`, /append-only/i);
    });

    it('rejects malformed rows through checks and keys', async () => {
      await rejected(insertReceipt('k1').replace('a'.repeat(64), 'short'), /check/i);
      await rejected(insertReceipt('k1').replace("'CommitEngagement'", "'lower'"), /check/i);
      await rejected(insertReceipt('k1').replace("'account-a'", "'bad actor'"), /check/i);
      const { receiptId, auditId } = await seed();
      const audit = (extra: string) =>
        `INSERT INTO "AuditEvent" ("receiptId","inboxId","ordinal","eventType","aggregateId","aggregateVersion","actorId","correlationId","payload") ${extra}`;
      const values = (receipt: string, inbox: string, over: Record<string, string> = {}) =>
        `VALUES (${receipt},${inbox},${over.ordinal ?? '5'},${over.type ?? "'work.x_done.v1'"},'a',${over.version ?? '1'},'account-a','c',${over.payload ?? "'{}'::jsonb"})`;
      await rejected(audit(values(`'${receiptId}'`, 'NULL', { type: "'bad.type'" })), /check/i);
      await rejected(audit(values(`'${receiptId}'`, 'NULL', { version: '0' })), /check/i);
      await rejected(audit(values(`'${receiptId}'`, 'NULL', { ordinal: '-1' })), /check/i);
      await rejected(audit(values(`'${receiptId}'`, 'NULL', { payload: "'[]'::jsonb" })), /check/i);
      await rejected(
        audit(
          values(`'${receiptId}'`, 'NULL', {
            payload: `jsonb_build_object('a', repeat('x', 5000))`,
          }),
        ),
        /check/i,
      );
      await rejected(audit(values('NULL', 'NULL')), /check/i);
      await rejected(audit(values(`'${receiptId}'`, `'${receiptId}'`)), /check|foreign key/i);
      await rejected(
        audit(values(`'${receiptId}'`, 'NULL', { ordinal: '0' })),
        /already exists|unique|duplicate/i,
      );
      await rejected(
        `INSERT INTO "OutboxEvent" ("eventId") VALUES ('${auditId}')`,
        /already exists|unique|duplicate/i,
      );
      await rejected(
        `INSERT INTO "OutboxEvent" ("eventId") VALUES (gen_random_uuid())`,
        /foreign key/i,
      );
    });

    it('cannot commit a receipt or inbox row without its result reference', async () => {
      const noResult = (table: 'CommandReceipt' | 'InboxDelivery') =>
        db.$transaction(async (tx) => {
          if (table === 'CommandReceipt') await tx.$executeRawUnsafe(insertReceipt('k-open', null));
          else
            await tx.$executeRawUnsafe(
              `INSERT INTO "InboxDelivery" ("provider","deliveryId","payloadDigest") VALUES ('p1','d1','${'a'.repeat(64)}')`,
            );
        });
      for (const table of ['CommandReceipt', 'InboxDelivery'] as const) {
        expect((await failure(noResult(table)))?.message ?? '').toMatch(/result/i);
      }
      expect(await counts()).toMatchObject({ receipts: 0, inbox: 0 });
    });

    it('allows the result reference to be set exactly once and nothing else to change', async () => {
      const finalize = (key: string, set: string) =>
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(insertReceipt(key, null));
          await tx.$executeRawUnsafe(
            `UPDATE "CommandReceipt" SET ${set} WHERE "idempotencyKey" = '${key}'`,
          );
        });
      await finalize('k-fin', `"resultRef" = 'done-1'`);
      expect(
        (await db.commandReceipt.findFirstOrThrow({ where: { idempotencyKey: 'k-fin' } }))
          .resultRef,
      ).toBe('done-1');
      expect(
        (await failure(finalize('k-fin-2', `"resultRef" = 'done-2', "requestId" = 'tampered'`)))
          ?.message ?? '',
      ).toMatch(/immutable/i);
      expect(await db.commandReceipt.count({ where: { idempotencyKey: 'k-fin-2' } })).toBe(0);
    });
  });
});
