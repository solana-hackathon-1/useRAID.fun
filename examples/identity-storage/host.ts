import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  ensureHumanParticipant,
  findHumanParticipant,
  type IdentityTransaction,
} from './identity-storage';
import {
  createPrismaIdentityTransaction,
  classifyIdentityStorageFailure,
} from './lib/identity-storage-adapter';

// This host has its own dependencies, schema and caller authority. Never load RAID config/db.
const url = new URL(process.env.DATABASE_URL ?? 'http://missing');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert(
  url.pathname === '/useraid_identity_host_test' ||
    /^\/useraid_test(_[a-z0-9]+)*$/.test(url.pathname),
);
assert(process.env.NODE_ENV !== 'production');
const db = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
const accountId = `synthetic-host-${randomUUID()}`;
const input = { accountId, actorAccountId: accountId, requestId: 'host-first' };
const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };
try {
  await db.$executeRawUnsafe(
    'INSERT INTO "User" (id, handle) VALUES ($1, $2)',
    accountId,
    'synthetic host',
  );
  const first = await db.$transaction(
    (tx) => ensureHumanParticipant(createPrismaIdentityTransaction(tx), input),
    options,
  );
  const second = await db.$transaction(
    (tx) =>
      ensureHumanParticipant(createPrismaIdentityTransaction(tx), {
        ...input,
        requestId: 'host-retry',
      }),
    options,
  );
  assert.deepEqual(second, first);
  assert.deepEqual(
    await db.$transaction(
      (tx) => findHumanParticipant(createPrismaIdentityTransaction(tx), accountId),
      options,
    ),
    first,
  );
  const alternate: IdentityTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    query: async <Row>() => [first] as Row[],
  };
  assert.deepEqual(await findHumanParticipant(alternate, accountId), first);
  await assert.rejects(ensureHumanParticipant(alternate, { ...input, actorAccountId: 'foreign' }), {
    code: 'WRONG_ACTOR',
  });
  const unavailable: IdentityTransaction = {
    ...alternate,
    query: async () => {
      throw Error('private driver failure');
    },
  };
  await assert.rejects(findHumanParticipant(unavailable, accountId), {
    message: 'STORAGE_UNAVAILABLE',
  });
  assert.equal(classifyIdentityStorageFailure({ code: 'P2034' }).code, 'RETRY_TRANSACTION');
  console.log(
    JSON.stringify({
      version: 'v1',
      synthetic: true,
      realDatabase: true,
      stableIdentity: true,
      alternatePort: true,
      wrongActorDenied: true,
      sanitizedFailure: true,
    }),
  );
} finally {
  await db.$disconnect();
}
