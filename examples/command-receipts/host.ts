import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import {
  CommandReceiptError,
  canonicalRequestDigest,
  executeIdempotentCommand,
  processInboundDelivery,
  type CommandReceiptTransaction,
} from './command-receipts';
import { runCommandTransaction } from './lib/command-receipts-adapter';

// This host has its own dependencies, schema and caller authority. Never load RAID config/db.
const url = new URL(process.env.DATABASE_URL ?? 'http://missing');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert(
  url.pathname === '/useraid_command_host_test' ||
    /^\/useraid_test(_[a-z0-9]+)*$/.test(url.pathname),
);
assert(process.env.NODE_ENV !== 'production');
const db = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
const run = randomUUID();
const actorId = `synthetic-host-${run}`;
const claimId = `claim-${run}`;
const credits = async () =>
  Number(
    (
      await db.$queryRawUnsafe<{ n: bigint }[]>(
        'SELECT count(*)::bigint AS n FROM "HostCredit" WHERE "claimId" = $1',
        claimId,
      )
    )[0].n,
  );
const command = (request: unknown) => ({
  actorId,
  commandKind: 'CreditClaim',
  idempotencyKey: `key-${run}`,
  requestId: `request-${randomUUID()}`,
  request,
});
const event = {
  type: 'treasury.claim_credited.v1',
  aggregateId: claimId,
  aggregateVersion: 1,
  payload: { claimId },
};
// The host's state change and the receipt share one transaction; the callback does only database work.
const credit = (request: unknown) =>
  runCommandTransaction(db, (port, tx) =>
    executeIdempotentCommand(port, command(request), async () => {
      await tx.$executeRawUnsafe('INSERT INTO "HostCredit" ("claimId") VALUES ($1)', claimId);
      return { resultRef: claimId, events: [event] };
    }),
  );
try {
  const request = { claim: claimId, amount: '2500000', memo: 'synthetic private note' };
  const first = await credit(request);
  const replay = await credit(request);
  assert.equal(first.status, 'EXECUTED');
  assert.deepEqual(replay, { ...first, status: 'REPLAYED' });
  const replayedWithoutSecondEffect = (await credits()) === 1;
  assert(replayedWithoutSecondEffect);

  const conflict = await credit({ ...request, amount: '9999999' }).catch((e) => e);
  assert(conflict instanceof CommandReceiptError);
  const changedPayloadConflict =
    conflict.code === 'IDEMPOTENCY_KEY_REUSED' && (await credits()) === 1;
  assert(changedPayloadConflict);

  const deliver = () =>
    runCommandTransaction(db, (port, tx) =>
      processInboundDelivery(
        port,
        {
          provider: 'synthetic-chain',
          verifiedDeliveryId: `delivery-${run}`,
          payload: { claimId },
        },
        async () => {
          await tx.$executeRawUnsafe('INSERT INTO "HostCredit" ("claimId") VALUES ($1)', claimId);
          return { resultRef: claimId, events: [event] };
        },
      ),
    );
  const [d1, d2] = [await deliver(), await deliver()];
  const duplicateDeliveryOneOutcome =
    d1.status === 'PROCESSED' && d2.status === 'DUPLICATE' && (await credits()) === 2;
  assert(duplicateDeliveryOneOutcome);

  // Alternate port: any adapter implementing CommandReceiptTransaction can serve a stored receipt.
  const stored = {
    id: 'receipt-0',
    requestDigest: canonicalRequestDigest(request),
    resultRef: claimId,
  };
  const alternate: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    query: async <Row>(sql: string) => (sql.includes('INSERT') ? [] : [stored]) as Row[],
  };
  const served = await executeIdempotentCommand(alternate, command(request), async () => {
    throw Error('callback must not run for a replay');
  });
  const alternatePort = served.status === 'REPLAYED' && served.receiptId === 'receipt-0';
  assert(alternatePort);

  const weak = { ...alternate, isolation: 'SERIALIZABLE' } as unknown as CommandReceiptTransaction;
  const gap = await executeIdempotentCommand(weak, command(request), async () => {
    throw Error('callback must not run without the capability');
  }).catch((e) => e);
  const capabilityGapFailsClosed =
    gap instanceof CommandReceiptError && gap.code === 'STORAGE_CONTRACT';
  assert(capabilityGapFailsClosed);

  const unavailable: CommandReceiptTransaction = {
    ...alternate,
    query: async () => {
      throw Error('private driver failure');
    },
  };
  const hidden = await executeIdempotentCommand(unavailable, command(request), async () => {
    throw Error('unreachable');
  }).catch((e) => e);
  const sanitizedFailure =
    hidden instanceof CommandReceiptError && hidden.message === 'STORAGE_UNAVAILABLE';
  assert(sanitizedFailure);

  console.log(
    JSON.stringify({
      version: 'v1',
      synthetic: true,
      realDatabase: true,
      replayedWithoutSecondEffect,
      changedPayloadConflict,
      duplicateDeliveryOneOutcome,
      alternatePort,
      capabilityGapFailsClosed,
      sanitizedFailure,
    }),
  );
} finally {
  await db.$disconnect();
}
