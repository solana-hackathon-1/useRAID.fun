import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { IdentityLinkError, linkVerifiedWallet, listWalletLinks } from '../src/identity-link';
import { IdentityStorageError, ensureHumanParticipant } from '../src/identity-storage';
import {
  classifyIdentityStorageFailure,
  createPrismaIdentityTransaction,
} from '../src/lib/identity-storage-adapter';
import { absorbAccount } from '../src/lib/account-merge';
import { createWalletChallenge, verifyWalletChallenge } from '../src/lib/wallet-auth';
import { config } from '../src/lib/config';
import { db as authDb } from '../src/lib/db';
import { failure } from '../src/lib/http';
import { absorbLegacyAccount } from './helpers/legacy-account-merge';
import { legacyLink, legacyRotate, legacySignIn } from './helpers/legacy-wallet-auth';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { creditUsdc } from './helpers/ledger';
import { fixtureAddress, fixtureLinkInput, fixtureProof } from './helpers/wallet-link-fixtures';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient({ log: [] });
const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 };
const W1 = fixtureAddress(1);
const W2 = fixtureAddress(2);
const W3 = fixtureAddress(3);
const W4 = fixtureAddress(4);
const W5 = fixtureAddress(5);
const W6 = fixtureAddress(6);
const port = (tx: Prisma.TransactionClient) => createPrismaIdentityTransaction(tx);
const link = (
  tx: Prisma.TransactionClient,
  accountId: string,
  address: string,
  extra: Record<string, unknown> = {},
) => linkVerifiedWallet(port(tx), fixtureLinkInput(accountId, address, extra));
const provision = (tx: Prisma.TransactionClient, accountId: string, requestId: string) =>
  ensureHumanParticipant(port(tx), { accountId, actorAccountId: accountId, requestId });
async function account(id: string, primary?: string, provisioned?: string) {
  await db.user.create({ data: { id, handle: id } });
  if (primary) await db.walletIdentity.create({ data: { address: primary, userId: id } });
  if (provisioned) await db.$transaction((tx) => provision(tx, id, provisioned), options);
}
const rows = (table: string) =>
  db.$queryRawUnsafe<unknown[]>(
    `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
  );
async function snapshot(tables: string[]) {
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = await rows(table);
  return result;
}
const MONEY = [
  'BalanceEntry',
  'UsdcTransfer',
  'UsdcAllocation',
  'RaidEnrollment',
  'RewardEnrollment',
  'WalletIdentity',
];
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function pid(tx: Prisma.TransactionClient) {
  return (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;
}
/** Runs `work` in a transaction that stays open (locks held) until `release()`. */
function holder<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  const started = deferred<number>();
  const release = deferred();
  const done = db.$transaction(async (tx) => {
    try {
      const result = await work(tx);
      started.resolve(await pid(tx));
      await release.promise;
      return result;
    } catch (error) {
      started.reject(error);
      throw error;
    }
  }, options);
  done.catch(() => undefined);
  return { pid: started.promise, release: release.resolve, done };
}
/** A competing transaction; resolves to its outcome instead of throwing. */
function contender<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
  const waiter = deferred<number>();
  const outcome = db
    .$transaction(async (tx) => {
      waiter.resolve(await pid(tx));
      return work(tx);
    }, options)
    .then(
      (value) => ({ ok: true as const, value, error: null }),
      (error: unknown) => ({ ok: false as const, value: null, error }),
    );
  return { pid: waiter.promise, outcome };
}
async function observeBlock(name: string, waiter: number, blocker: number, statement: RegExp) {
  expect(waiter).not.toBe(blocker);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const found = await db.$queryRawUnsafe<{ query: string; blockers: number[] }[]>(
      'SELECT query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1',
      waiter,
    );
    if (found[0]?.blockers.includes(blocker)) {
      expect(found[0].query).toMatch(statement);
      // Evidence comes from the PostgreSQL lock graph, never from elapsed sleep.
      console.info(
        JSON.stringify({
          walletLinkRace: name,
          waiter,
          blocker,
          blockedStatement: found[0].query.slice(0, 160),
        }),
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`Expected independent PostgreSQL blocker was not observed: ${name}`);
}
const codeOf = (error: unknown) =>
  error instanceof IdentityLinkError ? error.code : `OTHER:${String(error)}`;

integration('T006 wallet links on real PostgreSQL', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(() => truncateAll(db));
  afterAll(async () => {
    await truncateAll(db);
    await db.$disconnect();
    await authDb.$disconnect();
  });

  it('catalog contains the reviewed constraints, indexes and enabled triggers (D14)', async () => {
    const constraints = await db.$queryRawUnsafe<
      {
        conname: string;
        convalidated: boolean;
        confdeltype: string;
        confupdtype: string;
        cols: string;
      }[]
    >(
      `SELECT conname, convalidated, confdeltype::text, confupdtype::text,
        (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k.attnum) AS cols
       FROM pg_constraint WHERE conrelid = to_regclass('public."WalletLink"')`,
    );
    const names = constraints.map((c) => c.conname).sort();
    expect(names).toEqual(
      [
        'WalletLink_accountId_fkey',
        'WalletLink_actor_check',
        'WalletLink_address_check',
        'WalletLink_network_check',
        'WalletLink_participant_fkey',
        'WalletLink_pkey',
        'WalletLink_proof_check',
        'WalletLink_request_check',
        'WalletLink_revoked_check',
        'WalletLink_status_check',
      ].sort(),
    );
    expect(constraints.find((c) => c.conname === 'WalletLink_participant_fkey')).toMatchObject({
      convalidated: true,
      confdeltype: 'r',
      confupdtype: 'r',
      cols: 'participantId,accountId',
    });
    expect(constraints.find((c) => c.conname === 'WalletLink_accountId_fkey')).toMatchObject({
      confdeltype: 'r',
      confupdtype: 'r',
    });
    const indexes = await db.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('WalletLink','Participant') ORDER BY indexname`,
    );
    const byName = Object.fromEntries(indexes.map((i) => [i.indexname, i.indexdef]));
    expect(byName['WalletLink_address_key']).toMatch(/UNIQUE.*\(address\)/);
    expect(byName['WalletLink_proofRef_key']).toMatch(/UNIQUE.*\("proofRef"\)/);
    expect(byName['WalletLink_accountId_status_idx']).toMatch(/\("accountId", status\)/);
    expect(byName['Participant_id_accountId_key']).toMatch(/UNIQUE.*\(id, "accountId"\)/);
    const triggers = await db.$queryRawUnsafe<{ tgname: string; tgenabled: string; rel: string }[]>(
      `SELECT tgname, tgenabled::text, tgrelid::regclass::text AS rel FROM pg_trigger
        WHERE tgrelid IN (to_regclass('public."WalletLink"'), to_regclass('public."WalletIdentity"')) AND NOT tgisinternal
        ORDER BY tgname`,
    );
    expect(triggers).toEqual([
      { tgname: 'wallet_identity_subject_exclusive_v1', tgenabled: 'O', rel: '"WalletIdentity"' },
      { tgname: 'wallet_link_guard_v1', tgenabled: 'O', rel: '"WalletLink"' },
      { tgname: 'wallet_link_subject_exclusive_v1', tgenabled: 'O', rel: '"WalletLink"' },
    ]);
  });

  describe('AC01 identity half (D1) and legacy baseline', () => {
    async function history() {
      await creditUsdc(db, 'alice', 'synthetic-history', 12000000n, 'sandbox');
      const raid = await db.raid.create({
        data: {
          tag: 'synthetic',
          title: 'synthetic',
          description: 'synthetic',
          creatorId: 'bob',
          startsAt: new Date('2099-01-01'),
          endsAt: new Date('2099-01-02'),
        },
      });
      await db.raidEnrollment.create({
        data: { raidId: raid.id, userId: 'alice', xId: 'synthetic-x', walletAddress: W1 },
      });
    }
    it('a pre-provisioned participant is byte-identical after linking W2 and W3; money and payout rows unchanged (WR09)', async () => {
      await account('bob');
      await account('alice', W1, 'pre-request');
      await history();
      const participantBefore = await rows('Participant');
      const moneyBefore = await snapshot(MONEY);
      const existing = (await participantBefore[0]) as { row: { id: string } };
      const first = await db.$transaction(
        (tx) => link(tx, 'alice', W2, { requestId: 'link-2' }),
        options,
      );
      const second = await db.$transaction(
        (tx) => link(tx, 'alice', W3, { requestId: 'link-3' }),
        options,
      );
      expect(first).toMatchObject({ outcome: 'LINKED', participantId: existing.row.id });
      expect(second).toMatchObject({ outcome: 'LINKED', participantId: existing.row.id });
      expect(await rows('Participant')).toEqual(participantBefore); // ID, createdAt, provisioning actor/request
      expect(await snapshot(MONEY)).toEqual(moneyBefore);
      const links = await db.$transaction((tx) => listWalletLinks(port(tx), 'alice'), options);
      expect(links.map((l) => [l.address, l.status])).toEqual([
        [W2, 'ACTIVE'],
        [W3, 'ACTIVE'],
      ]);
      const stored = await db.$queryRawUnsafe<
        { participantId: string; linkRequestId: string; linkActorAccountId: string }[]
      >(
        `SELECT "participantId"::text, "linkRequestId", "linkActorAccountId" FROM "WalletLink" ORDER BY "linkRequestId"`,
      );
      expect(stored).toEqual([
        { participantId: existing.row.id, linkRequestId: 'link-2', linkActorAccountId: 'alice' },
        { participantId: existing.row.id, linkRequestId: 'link-3', linkActorAccountId: 'alice' },
      ]);
    });
    it('lazy creation: the first link creates one mapping with link provenance; later links reuse it', async () => {
      await account('alice', W1);
      expect(await rows('Participant')).toEqual([]);
      const first = await db.$transaction(
        (tx) => link(tx, 'alice', W2, { requestId: 'link-2' }),
        options,
      );
      const second = await db.$transaction(
        (tx) => link(tx, 'alice', W3, { requestId: 'link-3' }),
        options,
      );
      expect(second.participantId).toBe(first.participantId);
      const participants = await db.$queryRawUnsafe<{ provisionRequestId: string }[]>(
        'SELECT "provisionRequestId" FROM "Participant"',
      );
      expect(participants).toEqual([{ provisionRequestId: 'link-2' }]);
    });
    it('unchanged legacy link path still answers 409 for a second wallet until sign-in resolution ships (baseline)', async () => {
      config.demo = false;
      config.appUrl = 'http://localhost:3000';
      const pair = Keypair.generate();
      const second = Keypair.generate();
      await account('alice', pair.publicKey.toBase58());
      const address = second.publicKey.toBase58();
      const challenge = await createWalletChallenge(address, 'alice');
      const signature = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(challenge.message), second.secretKey),
      );
      await expect(
        verifyWalletChallenge(challenge.digest, signature, address, 'alice'),
      ).rejects.toMatchObject({
        status: 409,
        message: 'Account already has a wallet.',
      });
      expect(await db.walletIdentity.count()).toBe(1);
    });
  });

  describe('address exclusivity and old-binary behavior (D3, D4)', () => {
    it('two accounts linking one wallet: exactly one link; the loser leaves no mapping or consumed challenge', async () => {
      await account('alice', W1);
      await account('bob', W4);
      await db.walletChallenge.create({
        data: {
          digest: 'proof-b',
          address: W2,
          message: 'synthetic',
          userId: 'bob',
          expiresAt: new Date('2099-01-01'),
        },
      });
      const first = holder((tx) => link(tx, 'alice', W2, { requestId: 'a' }));
      const blocker = await first.pid;
      const second = contender(async (tx) => {
        await tx.walletChallenge.update({
          where: { digest: 'proof-b' },
          data: { consumedAt: new Date() },
        });
        return link(tx, 'bob', W2, { requestId: 'b', proof: fixtureProof('bob', W2, 'proof-b') });
      });
      try {
        await observeBlock(
          'link-vs-link-two-accounts-one-address',
          await second.pid,
          blocker,
          /pg_advisory_xact_lock/,
        );
      } finally {
        first.release();
      }
      await first.done;
      const loser = await second.outcome;
      expect(loser.ok).toBe(false);
      expect(codeOf(loser.error)).toBe('IDENTITY_CONFLICT');
      expect(await db.$queryRawUnsafe('SELECT "accountId" FROM "WalletLink"')).toEqual([
        { accountId: 'alice' },
      ]);
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: 'proof-b' } })).consumedAt,
      ).toBeNull();
      expect(
        await db.$queryRawUnsafe(`SELECT 1 FROM "Participant" WHERE "accountId"='bob'`),
      ).toEqual([]);
    });

    it('link then legacy sign-in at the same address: the legacy insert waits, then fails closed leaving no orphan user', async () => {
      await account('alice', W1);
      const users = await db.user.count();
      const first = holder((tx) => link(tx, 'alice', W2));
      const blocker = await first.pid;
      const legacy = contender((tx) => legacySignIn(tx, W2));
      try {
        await observeBlock(
          'link-then-legacy-insert',
          await legacy.pid,
          blocker,
          /INSERT INTO .*"WalletIdentity"/,
        );
      } finally {
        first.release();
      }
      await first.done;
      const outcome = await legacy.outcome;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({ code: 'P2002' });
      expect(await db.user.count()).toBe(users);
      expect(await db.walletIdentity.findUnique({ where: { address: W2 } })).toBeNull();
    });

    it('legacy sign-in creation then link at the same address: the link waits at the subject lock and reports a conflict', async () => {
      await account('alice', W1);
      const first = holder((tx) => legacySignIn(tx, W2));
      const blocker = await first.pid;
      const second = contender((tx) => link(tx, 'alice', W2));
      try {
        await observeBlock(
          'legacy-insert-then-link',
          await second.pid,
          blocker,
          /pg_advisory_xact_lock/,
        );
      } finally {
        first.release();
      }
      await first.done;
      const outcome = await second.outcome;
      expect(codeOf(outcome.error)).toBe('IDENTITY_CONFLICT');
      expect(await db.$queryRawUnsafe('SELECT 1 FROM "WalletLink"')).toEqual([]);
      expect(
        await db.$queryRawUnsafe(`SELECT 1 FROM "Participant" WHERE "accountId"='alice'`),
      ).toEqual([]);
    });

    it('old binary raw INSERT of a linked or revoked address fails with the exclusivity constraint (D4)', async () => {
      await account('alice', W1);
      await account('bob');
      await db.$transaction((tx) => link(tx, 'alice', W2), options);
      await db.$executeRawUnsafe(
        `UPDATE "WalletLink" SET status='REVOKED', "revokedAt"=now() WHERE address=$1`,
        W2,
      );
      for (const sql of [
        `INSERT INTO "WalletIdentity" (address, "userId") VALUES ('${W2}', 'bob')`,
        `UPDATE "WalletIdentity" SET address='${W2}' WHERE "userId"='alice'`,
      ])
        await expect(db.$executeRawUnsafe(sql)).rejects.toMatchObject({
          meta: { code: '23505' },
        });
      expect(
        (await db.walletIdentity.findUniqueOrThrow({ where: { userId: 'alice' } })).address,
      ).toBe(W1);
      expect(await db.walletIdentity.findUnique({ where: { address: W2 } })).toBeNull();
    });

    it('legacy sign-in with a linked or revoked address fails closed with no new account or session (rollout characterization)', async () => {
      await account('alice', W1);
      await db.$transaction((tx) => link(tx, 'alice', W2), options);
      await db.$transaction((tx) => link(tx, 'alice', W3), options);
      await db.$executeRawUnsafe(
        `UPDATE "WalletLink" SET status='REVOKED', "revokedAt"=now() WHERE address=$1`,
        W3,
      );
      const users = await db.user.count();
      for (const address of [W2, W3]) {
        await expect(
          db.$transaction((tx) => legacySignIn(tx, address), options),
        ).rejects.toMatchObject({
          code: 'P2002',
        });
        expect(await db.user.count()).toBe(users);
        expect(await db.session.count()).toBe(0);
      }
    });

    it('legacy link of a linked address by an account without a primary is rejected by the trigger', async () => {
      await account('alice', W1);
      await account('carol');
      await db.$transaction((tx) => link(tx, 'alice', W2), options);
      await expect(
        db.$transaction((tx) => legacyLink(tx, 'carol', W2), options),
      ).rejects.toMatchObject({
        code: 'P2002',
      });
      expect(await db.walletIdentity.count({ where: { userId: 'carol' } })).toBe(0);
    });
  });

  describe('SQLSTATE classification through real Prisma wrappers (WR01)', () => {
    it('trigger conflict and unique-index conflict both classify as sanitized UNIQUE_CONFLICT; the message never reaches logs', async () => {
      await account('alice', W1);
      await account('bob', W4);
      await db.$transaction((tx) => link(tx, 'alice', W2), options);
      const raw = await db
        .$executeRawUnsafe(
          `INSERT INTO "WalletIdentity" (address, "userId") VALUES ('${W2}', 'bob')`,
        )
        .catch((e: unknown) => e);
      expect(String((raw as Error).message)).toBeDefined();
      const participantId = (
        await db.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id::text FROM "Participant" WHERE "accountId"='alice'`,
        )
      )[0].id;
      const rawIndex = await db
        .$executeRawUnsafe(
          `INSERT INTO "WalletLink" ("accountId","participantId","networkIdentity",address,"proofRef","linkActorAccountId","linkRequestId")
           VALUES ('alice','${participantId}','mainnet','${W2}','proof-dup','alice','dup')`,
        )
        .catch((e: unknown) => e);
      // Precondition: the raw Prisma error does carry the address (that is why it must be sanitized).
      expect(
        JSON.stringify([
          String((rawIndex as Error).message),
          (rawIndex as { meta?: unknown }).meta,
        ]),
      ).toContain(W2);
      const attempts: [string, unknown[]][] = [
        [`INSERT INTO "WalletIdentity" (address, "userId") VALUES ($1, 'bob')`, [W2]],
        [
          `INSERT INTO "WalletLink" ("accountId","participantId","networkIdentity",address,"proofRef","linkActorAccountId","linkRequestId")
           VALUES ('alice',$2::uuid,'mainnet',$1,'proof-dup2','alice','dup2')`,
          [W2, participantId],
        ],
      ];
      for (const [sql, bindings] of attempts) {
        const error = await db
          .$transaction((tx) => port(tx).query(sql, bindings as string[]), options)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(IdentityStorageError);
        expect((error as IdentityStorageError).code).toBe('UNIQUE_CONFLICT');
        expect(String(error) + JSON.stringify(error)).not.toContain(W2);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          failure(error);
          expect(JSON.stringify(spy.mock.calls)).not.toContain(W2);
        } finally {
          spy.mockRestore();
        }
      }
      expect(classifyIdentityStorageFailure({ code: 'P2002', meta: { target: null } }).code).toBe(
        'UNIQUE_CONFLICT',
      );
      expect(
        classifyIdentityStorageFailure({ code: 'P2010', meta: { code: '23505', message: W2 } })
          .code,
      ).toBe('UNIQUE_CONFLICT');
    });
  });

  describe('documented lock order against every writer (WR12)', () => {
    it('link vs link on one account with different addresses serializes at the User row lock; one participant', async () => {
      await account('alice', W1);
      const first = holder((tx) => link(tx, 'alice', W2, { requestId: 'a' }));
      const blocker = await first.pid;
      const second = contender((tx) => link(tx, 'alice', W3, { requestId: 'b' }));
      try {
        await observeBlock(
          'link-vs-link-same-account',
          await second.pid,
          blocker,
          /FOR NO KEY UPDATE/,
        );
      } finally {
        first.release();
      }
      const a = await first.done;
      const b = await second.outcome;
      expect(b.ok).toBe(true);
      expect(b.value!.participantId).toBe(a.participantId);
      expect(await db.$queryRawUnsafe('SELECT 1 FROM "Participant"')).toHaveLength(1);
      expect(await db.$queryRawUnsafe('SELECT 1 FROM "WalletLink"')).toHaveLength(2);
    });

    it('link holding the subject vs rotate onto that address: rotate waits, then rolls back wholly and keeps the old primary', async () => {
      await account('alice', W1);
      await account('bob', W4);
      const first = holder((tx) => link(tx, 'alice', W2));
      const blocker = await first.pid;
      const rotate = contender((tx) => legacyRotate(tx, 'bob', W2));
      try {
        await observeBlock(
          'link-vs-rotate-link-first',
          await rotate.pid,
          blocker,
          /INSERT INTO .*"WalletIdentity"/,
        );
      } finally {
        first.release();
      }
      await first.done;
      const outcome = await rotate.outcome;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({ code: 'P2002' });
      expect(
        (await db.walletIdentity.findUniqueOrThrow({ where: { userId: 'bob' } })).address,
      ).toBe(W4);
    });

    it('rotate holding the subject vs link of that address: link waits, then reports a conflict', async () => {
      await account('alice', W1);
      await account('bob', W4);
      const first = holder((tx) => legacyRotate(tx, 'bob', W2));
      const blocker = await first.pid;
      const second = contender((tx) => link(tx, 'alice', W2));
      try {
        await observeBlock(
          'link-vs-rotate-rotate-first',
          await second.pid,
          blocker,
          /pg_advisory_xact_lock/,
        );
      } finally {
        first.release();
      }
      await first.done;
      expect(codeOf((await second.outcome).error)).toBe('IDENTITY_CONFLICT');
      expect(
        (await db.walletIdentity.findUniqueOrThrow({ where: { userId: 'bob' } })).address,
      ).toBe(W2);
    });

    it('legacy merge with the linking account as DROP: link first makes the final User delete fail and the whole merge roll back', async () => {
      await account('keep');
      await account('drop', W1);
      await db.session.create({
        data: { tokenHash: 'drop-session', userId: 'drop', expiresAt: new Date('2099-01-01') },
      });
      const before = await snapshot(['User', 'WalletIdentity', 'Session', 'ModerationEvent']);
      const first = holder((tx) => link(tx, 'drop', W2));
      const blocker = await first.pid;
      const merge = contender((tx) => absorbLegacyAccount(tx, 'keep', 'drop'));
      try {
        await observeBlock(
          'link-vs-merge-as-drop',
          await merge.pid,
          blocker,
          /DELETE FROM .*"User"/,
        );
      } finally {
        first.release();
      }
      await first.done;
      const outcome = await merge.outcome;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({ code: 'P2003' });
      expect(await snapshot(['User', 'WalletIdentity', 'Session', 'ModerationEvent'])).toEqual(
        before,
      );
      expect(await db.$queryRawUnsafe('SELECT 1 FROM "WalletLink"')).toHaveLength(1);
    });

    it('legacy merge deleting the linking account first: the link waits, then reports a missing account and leaves no orphan', async () => {
      await account('keep');
      await account('drop');
      await db.walletIdentity.create({ data: { address: W1, userId: 'drop' } });
      const first = holder((tx) => absorbLegacyAccount(tx, 'keep', 'drop'));
      const blocker = await first.pid;
      const second = contender((tx) => link(tx, 'drop', W2));
      try {
        await observeBlock(
          'link-vs-merge-delete-first',
          await second.pid,
          blocker,
          /FOR NO KEY UPDATE/,
        );
      } finally {
        first.release();
      }
      await first.done;
      expect(codeOf((await second.outcome).error)).toBe('ACCOUNT_NOT_FOUND');
      expect(await db.$queryRawUnsafe('SELECT 1 FROM "WalletLink"')).toEqual([]);
      expect(await db.$queryRawUnsafe('SELECT 1 FROM "Participant"')).toEqual([]);
    });

    it('legacy merge with the linking account as KEEP (User UPDATE) serializes with the link; both commit', async () => {
      await account('keep', W1);
      await account('drop');
      const first = holder((tx) => link(tx, 'keep', W2));
      const blocker = await first.pid;
      const merge = contender((tx) => absorbLegacyAccount(tx, 'keep', 'drop'));
      try {
        await observeBlock('link-vs-merge-as-keep', await merge.pid, blocker, /UPDATE .*"User"/);
      } finally {
        first.release();
      }
      await first.done;
      expect((await merge.outcome).ok).toBe(true);
      expect(await db.user.findUnique({ where: { id: 'drop' } })).toBeNull();
      expect(await db.$queryRawUnsafe('SELECT 1 FROM "WalletLink"')).toHaveLength(1);
    });

    it('a concurrent User row update (X sign-in shape) holding the row delays the link without a cycle', async () => {
      await account('alice', W1);
      const first = holder((tx) =>
        tx.user.update({ where: { id: 'alice' }, data: { handle: 'renamed' } }),
      );
      const blocker = await first.pid;
      const second = contender((tx) => link(tx, 'alice', W2));
      try {
        await observeBlock(
          'link-vs-user-row-update',
          await second.pid,
          blocker,
          /FOR NO KEY UPDATE/,
        );
      } finally {
        first.release();
      }
      await first.done;
      expect((await second.outcome).ok).toBe(true);
    });
  });

  describe('replay, state machine and constraints (D7, D8, D9)', () => {
    it('the same proof twice is one row; a proof reused for another address is a conflict that adds nothing', async () => {
      await account('alice', W1);
      const once = await db.$transaction((tx) => link(tx, 'alice', W2), options);
      const again = await db.$transaction((tx) => link(tx, 'alice', W2), options);
      expect(once.outcome).toBe('LINKED');
      expect(again).toMatchObject({
        outcome: 'ALREADY_LINKED',
        source: 'LINK',
        linkId: once.linkId,
      });
      await expect(
        db.$transaction(
          (tx) => link(tx, 'alice', W3, { proof: fixtureProof('alice', W3, `proof-${W2}`) }),
          options,
        ),
      ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
      expect(await db.$queryRawUnsafe('SELECT 1 FROM "WalletLink"')).toHaveLength(1);
    });

    it('own primary is an idempotent no-op that never creates a participant', async () => {
      await account('alice', W1);
      const result = await db.$transaction((tx) => link(tx, 'alice', W1), options);
      expect(result).toMatchObject({
        outcome: 'ALREADY_LINKED',
        source: 'PRIMARY',
        participantId: null,
      });
      expect(await rows('Participant')).toEqual([]);
    });

    it('requires an existing primary wallet and creates nothing otherwise (WR05)', async () => {
      await account('alice');
      await expect(db.$transaction((tx) => link(tx, 'alice', W2), options)).rejects.toMatchObject({
        code: 'PRIMARY_WALLET_REQUIRED',
      });
      expect(await rows('Participant')).toEqual([]);
      expect(await rows('WalletLink')).toEqual([]);
    });

    it('state machine: no delete, only ACTIVE to REVOKED, revoked address stays reserved for everyone', async () => {
      await account('alice', W1);
      await account('bob', W4);
      await db.$transaction((tx) => link(tx, 'alice', W2), options);
      for (const sql of [
        `DELETE FROM "WalletLink"`,
        `UPDATE "WalletLink" SET address='${W3}'`,
        `UPDATE "WalletLink" SET "proofRef"='changed'`,
        `UPDATE "WalletLink" SET status='REVOKED'`,
        `UPDATE "WalletLink" SET "linkRequestId"='changed'`,
      ])
        await expect(db.$executeRawUnsafe(sql)).rejects.toBeDefined();
      await db.$executeRawUnsafe(`UPDATE "WalletLink" SET id=id`); // no-op update is allowed
      await db.$executeRawUnsafe(`UPDATE "WalletLink" SET status='REVOKED', "revokedAt"=now()`);
      for (const sql of [
        `UPDATE "WalletLink" SET status='ACTIVE', "revokedAt"=NULL`,
        `UPDATE "WalletLink" SET "revokedAt"=now()`,
        `DELETE FROM "WalletLink"`,
      ])
        await expect(db.$executeRawUnsafe(sql)).rejects.toBeDefined();
      await expect(db.$transaction((tx) => link(tx, 'alice', W2), options)).rejects.toMatchObject({
        code: 'IDENTITY_REVOKED',
      });
      await expect(db.$transaction((tx) => link(tx, 'bob', W2), options)).rejects.toMatchObject({
        code: 'IDENTITY_CONFLICT',
      });
    });

    it('check constraints and the composite participant foreign key reject inconsistent rows', async () => {
      await account('alice', W1, 'p-alice');
      await account('bob', W4, 'p-bob');
      const bobParticipant = (
        await db.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id::text FROM "Participant" WHERE "accountId"='bob'`,
        )
      )[0].id;
      const insert = (overrides: Record<string, string>) => {
        const v = {
          accountId: 'alice',
          participantId: bobParticipant,
          address: W2,
          proofRef: 'proof-x',
          actor: 'alice',
          network: 'mainnet',
          ...overrides,
        };
        return db.$executeRawUnsafe(
          `INSERT INTO "WalletLink" ("accountId","participantId","networkIdentity",address,"proofRef","linkActorAccountId","linkRequestId")
           VALUES ('${v.accountId}','${v.participantId}','${v.network}','${v.address}','${v.proofRef}','${v.actor}','req')`,
        );
      };
      await expect(insert({})).rejects.toMatchObject({ meta: { code: '23503' } }); // another account's participant
      const own = (
        await db.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id::text FROM "Participant" WHERE "accountId"='alice'`,
        )
      )[0].id;
      await expect(insert({ participantId: own, actor: 'bob' })).rejects.toMatchObject({
        meta: { code: '23514' },
      });
      await expect(insert({ participantId: own, address: 'short' })).rejects.toMatchObject({
        meta: { code: '23514' },
      });
      await expect(insert({ participantId: own, network: 'bad network' })).rejects.toMatchObject({
        meta: { code: '23514' },
      });
      await insert({ participantId: own });
      await expect(
        insert({ participantId: own, address: W3, proofRef: 'proof-x' }),
      ).rejects.toMatchObject({
        meta: { code: '23505' },
      });
    });

    it('legacy User delete and merge of a linked account roll back entirely', async () => {
      await account('keep');
      await account('drop', W1);
      await db.$transaction((tx) => link(tx, 'drop', W2), options);
      const before = await snapshot([
        'User',
        'WalletIdentity',
        'WalletLink',
        'Participant',
        'ModerationEvent',
      ]);
      await expect(db.user.delete({ where: { id: 'drop' } })).rejects.toBeDefined();
      await expect(
        db.$transaction((tx) => absorbAccount(tx, 'keep', 'drop'), options),
      ).rejects.toThrow('Only an activity-free account');
      await expect(
        db.$transaction((tx) => absorbLegacyAccount(tx, 'keep', 'drop'), options),
      ).rejects.toMatchObject({
        code: 'P2003',
      });
      expect(
        await snapshot(['User', 'WalletIdentity', 'WalletLink', 'Participant', 'ModerationEvent']),
      ).toEqual(before);
    });

    it('a linked wallet-only account is rejected by the real wallet sign-in fold path and the merge helper (WR06 behavior)', async () => {
      config.demo = false;
      config.appUrl = 'http://localhost:3000';
      const owner = Keypair.generate();
      const address = owner.publicKey.toBase58();
      await account('owner', address);
      await account('current');
      await creditUsdc(db, 'current', 'activity', 5000000n, 'sandbox');
      await db.$transaction((tx) => link(tx, 'owner', W2), options);
      const before = await snapshot([
        'User',
        'WalletIdentity',
        'WalletLink',
        'Participant',
        'Session',
      ]);
      const challenge = await createWalletChallenge(address, 'current');
      const signature = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey),
      );
      await expect(
        verifyWalletChallenge(challenge.digest, signature, address, 'current'),
      ).rejects.toMatchObject({
        status: 409,
      });
      expect(
        await snapshot(['User', 'WalletIdentity', 'WalletLink', 'Participant', 'Session']),
      ).toEqual(before);
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: challenge.digest } }))
          .consumedAt,
      ).toBeNull();
    });
  });

  describe('restriction, retry and isolation (D10, D12, D13)', () => {
    it('a suspended account is restricted: no mapping, no link, challenge not consumed', async () => {
      await account('alice', W1);
      await db.user.update({ where: { id: 'alice' }, data: { suspended: true } });
      await db.walletChallenge.create({
        data: {
          digest: 'proof-s',
          address: W2,
          message: 'synthetic',
          userId: 'alice',
          expiresAt: new Date('2099-01-01'),
        },
      });
      await expect(
        db.$transaction(async (tx) => {
          await tx.walletChallenge.update({
            where: { digest: 'proof-s' },
            data: { consumedAt: new Date() },
          });
          return link(tx, 'alice', W2, { proof: fixtureProof('alice', W2, 'proof-s') });
        }, options),
      ).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
      expect(
        (await db.walletChallenge.findUniqueOrThrow({ where: { digest: 'proof-s' } })).consumedAt,
      ).toBeNull();
      expect(await rows('Participant')).toEqual([]);
      expect(await rows('WalletLink')).toEqual([]);
    });

    it('a suspended account re-linking its own wallet is restricted, not ALREADY_LINKED (WR08)', async () => {
      await account('alice', W1);
      await db.$transaction((tx) => link(tx, 'alice', W2), options);
      await db.user.update({ where: { id: 'alice' }, data: { suspended: true } });
      await expect(db.$transaction((tx) => link(tx, 'alice', W2), options)).rejects.toMatchObject({
        code: 'ACCOUNT_RESTRICTED',
      });
    });

    it.each([
      ['participant ensure', /INSERT INTO "Participant"/],
      ['link insert', /INSERT INTO "WalletLink"/],
    ])(
      'injected serialization failure at %s retries the whole callback with the same identity',
      async (_name, where) => {
        await account('alice', W1);
        let attempts = 0;
        for (;;) {
          attempts++;
          try {
            await db.$transaction(async (tx) => {
              const base = port(tx);
              const faulty = {
                ...base,
                async query<Row>(sql: string, bindings: readonly string[]) {
                  if (attempts === 1 && where.test(sql)) {
                    try {
                      await tx.$executeRawUnsafe(
                        `DO $$ BEGIN RAISE EXCEPTION 'synthetic retry' USING ERRCODE='40001'; END $$`,
                      );
                    } catch (e) {
                      throw classifyIdentityStorageFailure(e);
                    }
                  }
                  return base.query<Row>(sql, bindings);
                },
              };
              await linkVerifiedWallet(
                faulty,
                fixtureLinkInput('alice', W2, { requestId: 'same-request' }),
              );
            }, options);
            break;
          } catch (error) {
            expect(codeOf(error)).toBe('RETRY_TRANSACTION');
            expect(await rows('Participant')).toEqual([]);
            expect(await rows('WalletLink')).toEqual([]);
            if (attempts >= 2) throw error;
          }
        }
        expect(attempts).toBe(2);
        expect(await db.$queryRawUnsafe('SELECT "linkRequestId" FROM "WalletLink"')).toEqual([
          { linkRequestId: 'same-request' },
        ]);
        expect(await db.$queryRawUnsafe('SELECT 1 FROM "Participant"')).toHaveLength(1);
      },
    );

    it.each([
      ['SERIALIZABLE', Prisma.TransactionIsolationLevel.Serializable],
      ['REPEATABLE READ', Prisma.TransactionIsolationLevel.RepeatableRead],
    ])(
      'the adapter rejects %s before touching link tables (D13)',
      async (_name, isolationLevel) => {
        await account('alice', W1);
        await expect(
          db.$transaction((tx) => link(tx, 'alice', W2), { isolationLevel, timeout: 20000 }),
        ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
        expect(await rows('WalletLink')).toEqual([]);
      },
    );

    it('per-account caps hold at the database: active cap, then total ceiling including revoked rows', async () => {
      await account('alice', W1);
      const limits = { maxActiveLinks: 2, maxTotalLinks: 3 };
      await db.$transaction((tx) => link(tx, 'alice', W2, { limits }), options);
      await db.$transaction((tx) => link(tx, 'alice', W3, { limits }), options);
      await expect(
        db.$transaction((tx) => link(tx, 'alice', W5, { limits }), options),
      ).rejects.toMatchObject({
        code: 'LINK_LIMIT_REACHED',
      });
      await db.$executeRawUnsafe(
        `UPDATE "WalletLink" SET status='REVOKED', "revokedAt"=now() WHERE address=$1`,
        W3,
      );
      await db.$transaction((tx) => link(tx, 'alice', W5, { limits }), options);
      await db.$executeRawUnsafe(
        `UPDATE "WalletLink" SET status='REVOKED', "revokedAt"=now() WHERE address=$1`,
        W5,
      );
      await expect(
        db.$transaction((tx) => link(tx, 'alice', W6, { limits }), options),
      ).rejects.toMatchObject({
        code: 'LINK_LIMIT_REACHED',
      });
    });
  });

  describe('payout wallet is unchanged by links and rotation still works (D11)', () => {
    it('rotation to a fresh address works with links present; rotation onto an own link is refused by the fence', async () => {
      await account('alice', W1);
      await db.$transaction((tx) => link(tx, 'alice', W2), options);
      const links = await rows('WalletLink');
      await expect(
        db.$transaction((tx) => legacyRotate(tx, 'alice', W2), options),
      ).rejects.toMatchObject({
        code: 'P2002',
      });
      expect(
        (await db.walletIdentity.findUniqueOrThrow({ where: { userId: 'alice' } })).address,
      ).toBe(W1);
      await db.$transaction((tx) => legacyRotate(tx, 'alice', W6), options);
      expect(
        await db.walletIdentity.findUniqueOrThrow({ where: { userId: 'alice' } }),
      ).toMatchObject({
        address: W6,
        previousAddress: W1,
      });
      expect(await rows('WalletLink')).toEqual(links);
    });
  });

  describe('contract guards', () => {
    it('ensureHumanParticipant provenance is untouched by a no-op link replay', async () => {
      await account('alice', W1, 'first');
      await db.$transaction((tx) => link(tx, 'alice', W2, { requestId: 'later' }), options);
      expect(await db.$queryRawUnsafe('SELECT "provisionRequestId" FROM "Participant"')).toEqual([
        { provisionRequestId: 'first' },
      ]);
    });
  });
});
