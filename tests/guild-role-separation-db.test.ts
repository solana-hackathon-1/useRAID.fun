import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import {
  activateGuild,
  grantGuildRole,
  proposeOwnershipTransfer,
  respondOwnershipTransfer,
  revokeGuildRole,
  type GuildActor,
} from '../src/guild-profiles/guild-storage';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

/**
 * DEC-2026-11-13-04 (a)-(d): the Founder may issue TREASURY and DISPUTE grants; a database invariant keeps the Founder
 * from holding either and keeps one account from holding both in a Guild; a grant to the recipient of an open ownership
 * proposal is refused early. (e), a second approval before real funds, is deferred to O05/O06 and not tested here.
 */
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const FOUNDER_REJECTED = /A Guild Founder cannot hold treasury or dispute authority/;
const BOTH_REJECTED = /One account cannot hold treasury and dispute authority in the same Guild/;
let counter = 0;
type Client = PrismaClient;
async function person(client: Client = db): Promise<GuildActor> {
  const user = await client.user.create({ data: { handle: 'synthetic-sep-user-' + ++counter } });
  const sessionHash = hash(user.id);
  await client.session.create({
    data: {
      userId: user.id,
      tokenHash: sessionHash,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return { accountId: user.id, sessionHash };
}
const operators = new Set<string>();
const host = (allowNewWrites = true) => ({
  allowNewWrites,
  authorizeActivation: async (_tx: unknown, who: { accountId: string }) =>
    operators.has(who.accountId),
  authorizeOwnershipTransfer: async () => true,
});
let keyCounter = 0;
const cmd = (actor: GuildActor, input: unknown, key = 'key-' + ++keyCounter) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: 'request-' + key,
});
async function guild(slug = 'synthetic-sep-guild', client: Client = db) {
  const exec = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
    runCommandTransaction(client, work);
  const founder = await person(client);
  const operator = await person(client);
  operators.add(operator.accountId);
  const saved = await exec((tx) =>
    saveGuildDraft(
      tx,
      {
        actor: {
          accountId: founder.accountId,
          actorAccountId: founder.accountId,
          sessionHash: founder.sessionHash,
        },
        input: {
          guildDraftId: null,
          expectedRevision: 0,
          profile: { name: 'Synthetic ' + slug, slug, description: 'Synthetic description' },
        },
        idempotencyKey: 'draft-' + slug,
        requestId: 'request-draft-' + slug,
      },
      { allowNewWrites: true },
    ),
  );
  const activated = await exec((tx) =>
    activateGuild(
      tx,
      cmd(operator, {
        guildDraftId: saved.draft.id,
        expectedDraftRevision: saved.draft.revision,
        activationRef: 'evidence-record-' + slug,
      }),
      host(),
    ),
  );
  return { founder, operator, guild: activated.guild };
}
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const giveRole = (actor: GuildActor, guildId: string, input: Record<string, unknown>) =>
  run((tx) => grantGuildRole(tx, cmd(actor, { guildId, ...input }), host()));
const takeRole = (actor: GuildActor, guildId: string, grantId: string) =>
  run((tx) => revokeGuildRole(tx, cmd(actor, { guildId, grantId }), host()));
const propose = (actor: GuildActor, guildId: string, toAccountId: string, ms = 86400000) =>
  run((tx) =>
    proposeOwnershipTransfer(
      tx,
      cmd(actor, { guildId, toAccountId, expiresAt: new Date(Date.now() + ms).toISOString() }),
      host(),
    ),
  );
const respond = (actor: GuildActor, guildId: string, transferId: string, decision: string) =>
  run((tx) => respondOwnershipTransfer(tx, cmd(actor, { guildId, transferId, decision }), host()));
const INSERT = `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","grantedByAccountId") SELECT $1::uuid,$2,$3,ARRAY[]::text[],"founderAccountId" FROM "Guild" WHERE "id"=$1::uuid`;
/** A direct writer: the database invariant alone, with no application check in front of it. */
const rawGrant = (guildId: string, accountId: string, kind: string) =>
  db.$executeRawUnsafe(INSERT, guildId, accountId, kind);
/** A grant whose window ended an hour ago: history, never live. */
const expiredGrant = (
  client: Client,
  guildId: string,
  accountId: string,
  kind: string,
  issuer: string,
) =>
  client.$executeRawUnsafe(
    `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","validFrom","expiresAt","grantedByAccountId") VALUES ($1::uuid,$2,$3,ARRAY[]::text[],clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',$4)`,
    guildId,
    accountId,
    kind,
    issuer,
  );
const liveHolders = (guildId: string) =>
  db.$queryRawUnsafe<{ granteeAccountId: string; kind: string }[]>(
    `SELECT "granteeAccountId","kind" FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid AND "kind" IN ('TREASURY','DISPUTE') AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp()) ORDER BY "kind"`,
    guildId,
  );
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function untilBlocked() {
  for (let i = 0; i < 100; i++) {
    const waiting = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock'`,
    );
    if (waiting[0].n > 0) return;
    await pause(50);
  }
  throw new Error('the second writer never waited on the Guild lock');
}
const ACCEPT = `UPDATE "GuildOwnershipTransfer" SET "state"='ACCEPTED',"decidedAt"=clock_timestamp(),"decidedByAccountId"="toAccountId","decideReceiptId"="proposeReceiptId" WHERE "id"=$1::uuid`;
const SET_FOUNDER = `UPDATE "Guild" SET "founderAccountId"=$2 WHERE "id"=$1::uuid`;

integration('DEC-2026-11-13-04 TREASURY and DISPUTE separation', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    operators.clear();
  });
  afterAll(() => db.$disconnect());

  it('(a) lets the Founder issue TREASURY and DISPUTE grants to two different accounts', async () => {
    const { founder, guild: g } = await guild();
    const treasurer = await person();
    const judge = await person();
    await giveRole(founder, g.id, { granteeAccountId: treasurer.accountId, kind: 'TREASURY' });
    await giveRole(founder, g.id, { granteeAccountId: judge.accountId, kind: 'DISPUTE' });
    expect(await liveHolders(g.id)).toEqual([
      { granteeAccountId: judge.accountId, kind: 'DISPUTE' },
      { granteeAccountId: treasurer.accountId, kind: 'TREASURY' },
    ]);
  });

  it.each(['TREASURY', 'DISPUTE'])(
    '(b) the database refuses a live %s grant naming the current Founder, even from a direct writer',
    async (kind) => {
      const { founder, guild: g } = await guild();
      await expect(rawGrant(g.id, founder.accountId, kind)).rejects.toThrow(FOUNDER_REJECTED);
      expect(await liveHolders(g.id)).toEqual([]);
      // Other kinds, and a grant that can never be live, are not what the invariant is about.
      await rawGrant(g.id, founder.accountId, 'WORK');
      await expiredGrant(db, g.id, founder.accountId, kind, founder.accountId);
    },
  );

  it.each(['TREASURY', 'DISPUTE'])(
    '(b) the database refuses a Founder change to an account holding live %s',
    async (kind) => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const proposed = await propose(founder, g.id, next.accountId);
      // The recipient is not Founder yet, so a direct writer can give them the grant; the Founder change must refuse.
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(INSERT, g.id, next.accountId, kind);
          await tx.$executeRawUnsafe(ACCEPT, proposed.transfer.id);
          await tx.$executeRawUnsafe(SET_FOUNDER, g.id, next.accountId);
        }),
      ).rejects.toThrow(FOUNDER_REJECTED);
      const [row] = await db.$queryRawUnsafe<{ founder: string }[]>(
        `SELECT "founderAccountId" AS founder FROM "Guild" WHERE "id"=$1::uuid`,
        g.id,
      );
      expect(row.founder).toBe(founder.accountId);
    },
  );

  it('(c) one account cannot hold live TREASURY and DISPUTE in a Guild, from the app or a direct writer', async () => {
    const { founder, guild: g } = await guild();
    const other = await guild('other-sep-guild');
    const holder = await person();
    await giveRole(founder, g.id, { granteeAccountId: holder.accountId, kind: 'TREASURY' });
    await expect(
      giveRole(founder, g.id, { granteeAccountId: holder.accountId, kind: 'DISPUTE' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(rawGrant(g.id, holder.accountId, 'DISPUTE')).rejects.toThrow(BOTH_REJECTED);
    // The same kind twice is allowed, as is a different account or a different Guild.
    await rawGrant(g.id, holder.accountId, 'TREASURY');
    await giveRole(founder, g.id, {
      granteeAccountId: (await person()).accountId,
      kind: 'DISPUTE',
    });
    await giveRole(other.founder, other.guild.id, {
      granteeAccountId: holder.accountId,
      kind: 'DISPUTE',
    });
    expect(
      (await liveHolders(g.id)).filter((r) => r.granteeAccountId === holder.accountId),
    ).toEqual([
      { granteeAccountId: holder.accountId, kind: 'TREASURY' },
      { granteeAccountId: holder.accountId, kind: 'TREASURY' },
    ]);
  });

  it('(c) a revoked or expired grant no longer blocks the other kind', async () => {
    const { founder, guild: g } = await guild();
    const holder = await person();
    const first = await giveRole(founder, g.id, {
      granteeAccountId: holder.accountId,
      kind: 'TREASURY',
    });
    await takeRole(founder, g.id, first.grant.id);
    const second = await giveRole(founder, g.id, {
      granteeAccountId: holder.accountId,
      kind: 'DISPUTE',
    });
    await takeRole(founder, g.id, second.grant.id);
    // An expired DISPUTE grant does not block TREASURY either.
    await expiredGrant(db, g.id, holder.accountId, 'DISPUTE', founder.accountId);
    await rawGrant(g.id, holder.accountId, 'TREASURY');
  });

  it.each(['TREASURY', 'DISPUTE'])(
    '(d) refuses a %s grant to the recipient of an open ownership proposal until it is closed',
    async (kind) => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const proposed = await propose(founder, g.id, next.accountId);
      await expect(
        giveRole(founder, g.id, { granteeAccountId: next.accountId, kind }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Only the separate authorities are refused early.
      await giveRole(founder, g.id, { granteeAccountId: next.accountId, kind: 'WORK' });
      await respond(founder, g.id, proposed.transfer.id, 'WITHDRAW');
      await giveRole(founder, g.id, { granteeAccountId: next.accountId, kind });
    },
  );

  it('(d) a proposal past its window no longer blocks the grant', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    await propose(founder, g.id, next.accountId, 1200);
    await pause(1500);
    await giveRole(founder, g.id, { granteeAccountId: next.accountId, kind: 'TREASURY' });
  });

  it('serializes two direct writers on the Guild lock: the second sees the first and is refused', async () => {
    const { guild: g } = await guild();
    const holder = await person();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const first = new Promise<void>((resolve) => (inserted = resolve));
    const one = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(INSERT, g.id, holder.accountId, 'TREASURY');
        inserted();
        await gate;
      },
      { timeout: 30000 },
    );
    await first;
    const two = db.$transaction(
      (tx) => tx.$executeRawUnsafe(INSERT, g.id, holder.accountId, 'DISPUTE'),
      { timeout: 30000 },
    );
    const outcome = two.then(
      () => 'granted',
      (error: Error) => error.message,
    );
    try {
      await untilBlocked();
    } finally {
      release();
    }
    await one;
    expect(await outcome).toMatch(BOTH_REJECTED);
    expect(await liveHolders(g.id)).toEqual([
      { granteeAccountId: holder.accountId, kind: 'TREASURY' },
    ]);
  });

  it('serializes a grant against a Founder change: the waiting writer judges the Founder after the change', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const proposed = await propose(founder, g.id, next.accountId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (locked = resolve));
    // The Founder change holds the Guild row. It is left uncommitted and rolled back, because only the lock and the
    // waiting writer's behaviour matter here (the commit-time receipt guards are covered by the ownership tests).
    const change = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(ACCEPT, proposed.transfer.id);
        await tx.$executeRawUnsafe(SET_FOUNDER, g.id, next.accountId);
        locked();
        await gate;
        throw new Error('rollback-after-check');
      },
      { timeout: 30000 },
    );
    const settled = change.then(
      () => 'committed',
      (error: Error) => error.message,
    );
    await held;
    const grant = db.$executeRawUnsafe(INSERT, g.id, next.accountId, 'TREASURY').then(
      () => 'granted',
      (error: Error) => error.message,
    );
    try {
      await untilBlocked();
    } finally {
      release();
    }
    expect(await settled).toBe('rollback-after-check');
    // The change rolled back, so the incoming Founder is still an ordinary account and the waiting grant is allowed.
    expect(await grant).toBe('granted');
  });

  it('(app race) a TREASURY and a DISPUTE grant to one account issued together: exactly one succeeds', async () => {
    for (let i = 0; i < 3; i++) {
      await truncateAll(db);
      operators.clear();
      const { founder, guild: g } = await guild('race-grants-' + i);
      const holder = await person();
      const results = await Promise.allSettled(
        ['TREASURY', 'DISPUTE'].map((kind) =>
          giveRole(founder, g.id, { granteeAccountId: holder.accountId, kind }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'FORBIDDEN' });
      expect(await liveHolders(g.id)).toHaveLength(1);
    }
  });

  it('(app race) a proposal and a TREASURY grant to the same account issued together never both succeed', async () => {
    for (let i = 0; i < 3; i++) {
      await truncateAll(db);
      operators.clear();
      const { founder, guild: g } = await guild('race-propose-' + i);
      const next = await person();
      const [proposal, granted] = await Promise.allSettled([
        propose(founder, g.id, next.accountId),
        giveRole(founder, g.id, { granteeAccountId: next.accountId, kind: 'TREASURY' }),
      ]);
      expect([proposal.status, granted.status].sort()).toEqual(['fulfilled', 'rejected']);
    }
  });
});

integration('DEC-2026-11-13-04 migration on existing history', () => {
  const migration = '202611130007_guild_role_separation';
  const triggers = `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('guild_grant_separation_v1','guild_founder_separation_v1')`;
  it.each([
    ['clean', 'passes'],
    ['founder-treasury', 'fails'],
    ['founder-dispute', 'fails'],
    ['both-kinds', 'fails'],
    ['harmless-history', 'passes'],
  ] as const)(
    'with %s rows the migration %s without altering any row',
    async (kind, expected) => {
      assertTestDatabase();
      const name = 'useraid_test_sep_' + randomUUID().replaceAll('-', '');
      const directory = mkdtempSync(join(tmpdir(), 'raid-guild-separation-'));
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = '/' + name;
      const database = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      try {
        await db.$executeRawUnsafe('CREATE DATABASE "' + name + '"');
        cpSync('prisma', join(directory, 'prisma'), {
          recursive: true,
          filter: (path) => !path.includes(migration),
        });
        const deploy = () =>
          spawnSync(
            'node_modules/.bin/prisma',
            ['migrate', 'deploy', '--schema', join(directory, 'prisma/schema.prisma')],
            { env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8' },
          );
        const before = deploy();
        expect(before.status, before.stdout + before.stderr).toBe(0);
        const g = await guild('upgrade-' + kind, database);
        const holder = await person(database);
        const issuer = g.founder.accountId;
        const insert = (account: string, k: string) =>
          database.$executeRawUnsafe(
            `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","grantedByAccountId") VALUES ($1::uuid,$2,$3,ARRAY[]::text[],$4)`,
            g.guild.id,
            account,
            k,
            issuer,
          );
        if (kind === 'founder-treasury') await insert(issuer, 'TREASURY');
        if (kind === 'founder-dispute') await insert(issuer, 'DISPUTE');
        if (kind === 'both-kinds') {
          await insert(holder.accountId, 'TREASURY');
          await insert(holder.accountId, 'DISPUTE');
        }
        if (kind === 'harmless-history') {
          // A revoked TREASURY beside a live DISPUTE, and an expired Founder grant: history, not live conflicts.
          await insert(holder.accountId, 'TREASURY');
          await database.$executeRawUnsafe(
            `UPDATE "GuildRoleGrant" SET "revokedAt"=clock_timestamp() WHERE "granteeAccountId"=$1 AND "kind"='TREASURY'`,
            holder.accountId,
          );
          await insert(holder.accountId, 'DISPUTE');
          await expiredGrant(database, g.guild.id, issuer, 'TREASURY', issuer);
        }
        const rows = () => database.$queryRawUnsafe('SELECT * FROM "GuildRoleGrant" ORDER BY "id"');
        const grantsBefore = await rows();
        cpSync(
          join('prisma/migrations', migration),
          join(directory, 'prisma/migrations', migration),
          { recursive: true },
        );
        const after = deploy();
        if (expected === 'passes') {
          expect(after.status, after.stdout + after.stderr).toBe(0);
          expect((await database.$queryRawUnsafe<{ n: number }[]>(triggers))[0].n).toBe(2);
        } else {
          expect(after.status).not.toBe(0);
          expect(after.stdout + after.stderr).toMatch(
            /Guild role separation: \d+ conflicting grant\(s\); resolve them before this migration/,
          );
          expect((await database.$queryRawUnsafe<{ n: number }[]>(triggers))[0].n).toBe(0);
        }
        expect(await rows()).toEqual(grantsBefore);
      } finally {
        await database.$disconnect();
        await db.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + name + '"');
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120000,
  );
});
