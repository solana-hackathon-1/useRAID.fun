import { createHash, randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  IdentityLinkError,
  linkVerifiedWallet,
  listWalletLinks,
  lookupWalletLink,
  type IdentityTransaction,
} from './identity-link';
import { createPrismaIdentityTransaction } from './lib/identity-storage-adapter';
import {
  LINK_ADDITIONAL_STATEMENT,
  SIWS_CHAIN_ID,
  deriveWalletLinkProof,
} from './lib/wallet-link-proof';

// This host has its own dependencies, schema, clock, policy and caller authority. Never load RAID config/db.
const url = new URL(process.env.DATABASE_URL ?? 'http://missing');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert(['/useraid_wallet_links_host_test', '/useraid_test'].includes(url.pathname));
assert(process.env.NODE_ENV !== 'production');
const db = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [] });
const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };
const policy = {
  domain: 'localhost:3000',
  uri: 'http://localhost:3000',
  walletNetworks: [SIWS_CHAIN_ID],
  providers: [],
};
const limits = { maxActiveLinks: 5, maxTotalLinks: 20 };
const address = () => bs58.encode(randomBytes(32));
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'NO_ERROR',
    (error: unknown) => (error instanceof IdentityLinkError ? error.code : `OTHER:${error}`),
  );

// The host's challenge store: a signed message and its stored row. Signature verification and the
// atomic claim of the row are host responsibilities (not shown); the module only sees the result.
function storedChallenge(accountId: string, wallet: string, now: Date) {
  const issued = new Date(+now - 60_000).toISOString();
  const expires = new Date(+now + 240_000);
  const message = `localhost:3000 wants you to sign in with your Solana account:\n${wallet}\n\n${LINK_ADDITIONAL_STATEMENT}\n\nURI: http://localhost:3000\nVersion: 1\nChain ID: ${SIWS_CHAIN_ID}\nNonce: ${randomBytes(24).toString('base64url')}\nIssued At: ${issued}\nExpiration Time: ${expires.toISOString()}`;
  return {
    digest: createHash('sha256').update(message).digest('hex'),
    address: wallet,
    message,
    userId: accountId,
    expiresAt: expires,
    consumedAt: null,
  };
}
function request(accountId: string, wallet: string, requestId: string, overrides = {}) {
  const now = new Date();
  return {
    accountId,
    actorAccountId: accountId,
    requestId,
    subject: { networkIdentity: SIWS_CHAIN_ID, address: wallet },
    proof: deriveWalletLinkProof(storedChallenge(accountId, wallet, now), {
      signatureVerified: true,
    }),
    session: { accountId, state: 'ACTIVE', expiresAt: new Date(+now + 3_600_000).toISOString() },
    policy,
    now: now.toISOString(),
    limits,
    ...overrides,
  };
}
const link = (input: ReturnType<typeof request>) =>
  db.$transaction((tx) => linkVerifiedWallet(createPrismaIdentityTransaction(tx), input), options);

const alice = `synthetic-host-${randomUUID()}`;
const bob = `synthetic-host-${randomUUID()}`;
const carol = `synthetic-host-${randomUUID()}`;
const [primary, second, third, bobPrimary] = [address(), address(), address(), address()];
try {
  for (const id of [alice, bob, carol])
    await db.$executeRawUnsafe(
      'INSERT INTO "User" (id, handle) VALUES ($1, $2)',
      id,
      'synthetic host',
    );
  await db.$executeRawUnsafe(
    'INSERT INTO "WalletIdentity" (address, "userId") VALUES ($1, $2)',
    primary,
    alice,
  );
  await db.$executeRawUnsafe(
    'INSERT INTO "WalletIdentity" (address, "userId") VALUES ($1, $2)',
    bobPrimary,
    bob,
  );
  const payout = () =>
    db.$queryRawUnsafe('SELECT to_jsonb(t) AS row FROM "WalletIdentity" t ORDER BY address');
  const payoutBefore = await payout();

  const first = await link(request(alice, second, 'host-link-2'));
  const next = await link(request(alice, third, 'host-link-3'));
  assert.equal(first.outcome, 'LINKED');
  assert.equal(next.participantId, first.participantId);
  assert.deepEqual(await payout(), payoutBefore);
  const replay = await link(request(alice, second, 'host-link-2-retry'));
  assert.equal(replay.outcome, 'ALREADY_LINKED');
  assert.equal(replay.linkId, first.linkId);
  assert.equal(await code(link(request(bob, second, 'host-bob'))), 'IDENTITY_CONFLICT');
  assert.equal(
    await code(link(request(carol, address(), 'host-carol'))),
    'PRIMARY_WALLET_REQUIRED',
  );
  assert.equal(
    await code(link(request(alice, address(), 'host-alice', { actorAccountId: bob }))),
    'WRONG_ACTOR',
  );
  const listed = await db.$transaction(
    (tx) => listWalletLinks(createPrismaIdentityTransaction(tx), alice),
    options,
  );
  assert.deepEqual(listed.map((row) => row.address).sort(), [second, third].sort());

  const alternate: IdentityTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    query: async <Row>() =>
      [
        {
          id: randomUUID(),
          address: second,
          networkIdentity: SIWS_CHAIN_ID,
          status: 'ACTIVE',
          verifiedAt: '2026-10-09T00:00:00.000Z',
          revokedAt: null,
        },
      ] as Row[],
  };
  assert.equal((await listWalletLinks(alternate, alice))[0].address, second);
  const unavailable: IdentityTransaction = {
    ...alternate,
    query: async () => {
      throw Error(`private driver failure ${second}`);
    },
  };
  await assert.rejects(listWalletLinks(unavailable, alice), { message: 'STORAGE_UNAVAILABLE' });
  const credential = await db.$transaction(
    (tx) => lookupWalletLink(createPrismaIdentityTransaction(tx), second),
    options,
  );
  assert.equal(credential?.accountId, alice);
  assert.equal(credential?.status, 'ACTIVE');
  await db.$executeRawUnsafe(
    'UPDATE "WalletLink" SET status=\'REVOKED\', "revokedAt"=now() WHERE address=$1',
    third,
  );
  const revoked = await db.$transaction(
    (tx) => lookupWalletLink(createPrismaIdentityTransaction(tx), third),
    options,
  );
  assert.equal(revoked?.status, 'REVOKED');
  assert.deepEqual(await payout(), payoutBefore);
  const lookupAlternate: IdentityTransaction = {
    ...alternate,
    query: async <Row>(sql: string) =>
      (sql.includes('pg_advisory_xact_lock')
        ? [{ locked: 1 }]
        : sql.includes('FROM "User"')
          ? [{ id: alice, suspended: false }]
          : sql.includes('FOR SHARE')
            ? [{ accountId: alice, networkIdentity: SIWS_CHAIN_ID, status: 'ACTIVE' }]
            : [{ accountId: alice }]) as Row[],
  };
  assert.deepEqual(await lookupWalletLink(lookupAlternate, second), credential);
  console.log(
    JSON.stringify({
      version: 'v1',
      synthetic: true,
      realDatabase: true,
      sameParticipant: true,
      primaryUnchanged: true,
      idempotentReplay: true,
      foreignAddressConflict: true,
      primaryRequired: true,
      wrongActorDenied: true,
      proofDerived: true,
      alternatePort: true,
      sanitizedFailure: true,
      linkedCredentialOwner: true,
      revokedCredentialReserved: true,
      lookupAlternatePort: true,
    }),
  );
} finally {
  await db.$disconnect();
}
