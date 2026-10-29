import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import {
  activateGuild,
  editGuildProfile,
  grantGuildRole,
  hasGuildAuthority,
  proposeOwnershipTransfer,
  readManagedGuild,
  respondOwnershipTransfer,
  revokeGuildRole,
  type GuildActor,
} from '../src/guild-profiles/guild-storage';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
let counter = 0;
async function person(): Promise<GuildActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-guild-user-' + ++counter } });
  const sessionHash = hash(user.id);
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: sessionHash,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return { accountId: user.id, sessionHash };
}
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const operators = new Set<string>();
const host = (allowNewWrites = true) => ({
  allowNewWrites,
  authorizeActivation: async (_tx: unknown, who: { accountId: string }) =>
    operators.has(who.accountId),
});
let keyCounter = 0;
const cmd = (actor: GuildActor, input: unknown, key = 'key-' + ++keyCounter) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: 'request-' + key,
});
async function draftFor(owner: GuildActor, slug: string) {
  const saved = await run((tx) =>
    saveGuildDraft(
      tx,
      {
        actor: {
          accountId: owner.accountId,
          actorAccountId: owner.accountId,
          sessionHash: owner.sessionHash,
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
  return saved.draft;
}
/** An operator-activated Guild whose Founder is the draft owner. */
async function guild(slug = 'synthetic-guild') {
  const founder = await person();
  const operator = await person();
  operators.add(operator.accountId);
  const draft = await draftFor(founder, slug);
  const activated = await run((tx) =>
    activateGuild(
      tx,
      cmd(operator, {
        guildDraftId: draft.id,
        expectedDraftRevision: draft.revision,
        activationRef: 'evidence-record-' + slug,
      }),
      host(),
    ),
  );
  return { founder, operator, draft, guild: activated.guild };
}
const edit = (
  actor: GuildActor,
  guildId: string,
  expectedRevision: number,
  profile: unknown,
  key?: string,
  writes = true,
) =>
  run((tx) =>
    editGuildProfile(tx, cmd(actor, { guildId, expectedRevision, profile }, key), host(writes)),
  );

let approve = true;
const ownerHost = (allowNewWrites = true) => ({
  allowNewWrites,
  authorizeOwnershipTransfer: async () => approve,
});
const propose = (
  actor: GuildActor,
  guildId: string,
  toAccountId: string,
  extra: Record<string, unknown> = {},
  key?: string,
  writes = true,
) =>
  run((tx) =>
    proposeOwnershipTransfer(
      tx,
      cmd(
        actor,
        {
          guildId,
          toAccountId,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          ...extra,
        },
        key,
      ),
      ownerHost(writes),
    ),
  );
const respond = (
  actor: GuildActor,
  guildId: string,
  transferId: string,
  decision: string,
  key?: string,
  writes = true,
) =>
  run((tx) =>
    respondOwnershipTransfer(
      tx,
      cmd(actor, { guildId, transferId, decision }, key),
      ownerHost(writes),
    ),
  );
const grant = (actor: GuildActor, input: Record<string, unknown>, key?: string) =>
  run((tx) => grantGuildRole(tx, cmd(actor, input, key), ownerHost()));
const revoke = (actor: GuildActor, guildId: string, grantId: string, key?: string) =>
  run((tx) => revokeGuildRole(tx, cmd(actor, { guildId, grantId }, key), ownerHost()));
const founderOf = async (guildId: string) =>
  (
    await db.$queryRawUnsafe<{ f: string }[]>(
      `SELECT "founderAccountId" AS f FROM "Guild" WHERE "id"=$1::uuid`,
      guildId,
    )
  )[0].f;
const grantRow = (guildId: string, grantee: GuildActor) =>
  db.$executeRawUnsafe(
    `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","grantedByAccountId") SELECT $1::uuid,$2,'PROFILE',ARRAY['name'],"founderAccountId" FROM "Guild" WHERE "id"=$1::uuid`,
    guildId,
    grantee.accountId,
  );
integration('T009 Guild ownership transfer', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    operators.clear();
    approve = true;
  });
  afterAll(() => db.$disconnect());

  it('moves the Founder role only after the Founder proposes and the recipient accepts', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const proposed = await propose(founder, g.id, next.accountId, {}, 'p-1');
    expect(proposed).toMatchObject({
      status: 'EXECUTED',
      transfer: {
        guildId: g.id,
        fromAccountId: founder.accountId,
        toAccountId: next.accountId,
        state: 'PROPOSED',
        applied: false,
      },
    });
    expect(
      (
        await propose(
          founder,
          g.id,
          next.accountId,
          { expiresAt: proposed.transfer.expiresAt },
          'p-1',
        )
      ).transfer.id,
    ).toBe(proposed.transfer.id);
    // Nothing has moved yet.
    expect((await run((tx) => readManagedGuild(tx, founder, g.id))).authority.founder).toBe(true);
    await expect(edit(next, g.id, 1, { name: 'Early' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const done = await respond(next, g.id, proposed.transfer.id, 'ACCEPT', 'a-1');
    expect(done).toMatchObject({
      status: 'EXECUTED',
      transfer: { state: 'ACCEPTED', applied: true },
    });
    expect((await respond(next, g.id, proposed.transfer.id, 'ACCEPT', 'a-1')).status).toBe(
      'REPLAYED',
    );
    const [row] = await db.$queryRawUnsafe<{ founder: string; revision: number }[]>(
      `SELECT "founderAccountId" AS founder,"revision" FROM "Guild" WHERE "id"=$1::uuid`,
      g.id,
    );
    expect(row).toEqual({ founder: next.accountId, revision: 1 });
    // The former Founder holds no role by default; the new Founder does.
    await expect(edit(founder, g.id, 1, { name: 'Former' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await edit(next, g.id, 1, { name: 'New Founder' })).guild.name).toBe('New Founder');
    for (const [kind, who, expected] of [
      ['PROFILE', founder, false],
      ['WORK', founder, false],
      ['PROFILE', next, true],
      ['WORK', next, true],
      ['TREASURY', next, false],
    ] as const)
      expect(await run((tx) => hasGuildAuthority(tx, who.accountId, g.id, kind))).toBe(expected);
    const events = await db.$queryRawUnsafe<{ eventType: string }[]>(
      `SELECT "eventType" FROM "AuditEvent" WHERE "guildId"=$1 AND "eventType" LIKE 'guild.ownership_%' ORDER BY "occurredAt"`,
      g.id,
    );
    expect(events.map((e) => e.eventType)).toEqual([
      'guild.ownership_proposed.v1',
      'guild.ownership_transferred.v1',
    ]);
  });

  it('refuses proposals from anyone but the current Founder, to oneself, to a suspended account, or twice at once', async () => {
    const { founder, guild: g } = await guild();
    const other = await guild('other-guild');
    const delegate = await person();
    await grantRow(g.id, delegate);
    const target = await person();
    await expect(propose(delegate, g.id, target.accountId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(propose(other.founder, g.id, target.accountId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(propose(founder, g.id, founder.accountId)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const suspended = await person();
    await db.user.update({ where: { id: suspended.accountId }, data: { suspended: true } });
    await expect(propose(founder, g.id, suspended.accountId)).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
    await expect(propose(founder, g.id, 'no-such-account')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      propose(founder, g.id, target.accountId, {
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      propose(founder, g.id, target.accountId, {
        expiresAt: new Date(Date.now() + 40 * 86400000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(propose(founder, g.id, target.accountId, {}, 'w', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    await propose(founder, g.id, target.accountId, {}, 'first');
    await expect(
      propose(founder, g.id, (await person()).accountId, {}, 'second'),
    ).rejects.toMatchObject({ code: 'TRANSFER_PENDING' });
  });

  it('lets only the recipient accept or decline and only the Founder withdraw; a decided transfer is final', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const stranger = await person();
    const t1 = (await propose(founder, g.id, next.accountId, {}, 'p-1')).transfer.id;
    await expect(respond(founder, g.id, t1, 'ACCEPT')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(respond(stranger, g.id, t1, 'ACCEPT')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(respond(next, g.id, t1, 'WITHDRAW')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(respond(stranger, g.id, t1, 'WITHDRAW')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await respond(next, g.id, t1, 'DECLINE')).transfer.state).toBe('DECLINED');
    await expect(respond(next, g.id, t1, 'ACCEPT', 'late')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    const t2 = (await propose(founder, g.id, next.accountId, {}, 'p-2')).transfer.id;
    expect((await respond(founder, g.id, t2, 'WITHDRAW')).transfer.state).toBe('WITHDRAWN');
    await expect(respond(next, g.id, t2, 'ACCEPT', 'late-2')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(
      respond(next, g.id, '00000000-0000-4000-8000-000000000000', 'ACCEPT'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [{ founderAccountId }] = await db.$queryRawUnsafe<{ founderAccountId: string }[]>(
      `SELECT "founderAccountId" FROM "Guild" WHERE "id"=$1::uuid`,
      g.id,
    );
    expect(founderAccountId).toBe(founder.accountId);
  });

  it('records an expired proposal as expired instead of applying it, and lets a new one be made', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const id = (await propose(founder, g.id, next.accountId, {}, 'p-1')).transfer.id;
    // Move the window into the past the way only a direct writer could, to avoid sleeping.
    await db.$executeRawUnsafe(
      `ALTER TABLE "GuildOwnershipTransfer" DISABLE TRIGGER guild_transfer_guard_v1`,
    );
    try {
      await db.$executeRawUnsafe(
        `UPDATE "GuildOwnershipTransfer" SET "proposedAt"=clock_timestamp()-interval '2 days',"expiresAt"=clock_timestamp()-interval '1 day' WHERE "id"=$1::uuid`,
        id,
      );
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "GuildOwnershipTransfer" ENABLE TRIGGER guild_transfer_guard_v1`,
      );
    }
    const lapsed = await respond(next, g.id, id, 'ACCEPT', 'late');
    expect(lapsed.transfer).toMatchObject({ state: 'EXPIRED', applied: false });
    const [{ founderAccountId }] = await db.$queryRawUnsafe<{ founderAccountId: string }[]>(
      `SELECT "founderAccountId" FROM "Guild" WHERE "id"=$1::uuid`,
      g.id,
    );
    expect(founderAccountId).toBe(founder.accountId);
    expect((await propose(founder, g.id, next.accountId, {}, 'p-2')).transfer.state).toBe(
      'PROPOSED',
    );
  });

  it('applies nothing when the host does not approve the ownership change', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    approve = false;
    await expect(respond(next, g.id, id, 'ACCEPT')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [{ state }] = await db.$queryRawUnsafe<{ state: string }[]>(
      `SELECT "state" FROM "GuildOwnershipTransfer" WHERE "id"=$1::uuid`,
      id,
    );
    expect(state).toBe('PROPOSED');
    approve = true;
    expect((await respond(next, g.id, id, 'ACCEPT')).transfer.applied).toBe(true);
  });

  it('refuses a recipient who was suspended and a transfer whose Founder changed meanwhile', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    await db.user.update({ where: { id: next.accountId }, data: { suspended: true } });
    await expect(respond(next, g.id, id, 'ACCEPT')).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
  });

  it('rejects direct writers that rewrite the Founder or a transfer', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    const attempt = (sql: string) =>
      db.$executeRawUnsafe(sql).then(
        () => 'accepted',
        (e: Error) => (/Guild/.test(e.message) ? 'guarded' : 'other:' + e.message),
      );
    expect(
      await attempt(
        `UPDATE "Guild" SET "founderAccountId"='${next.accountId}' WHERE "id"='${g.id}'`,
      ),
    ).toBe('guarded');
    expect(
      await attempt(
        `UPDATE "GuildOwnershipTransfer" SET "toAccountId"='${founder.accountId}' WHERE "id"='${id}'`,
      ),
    ).toBe('guarded');
    expect(await attempt(`DELETE FROM "GuildOwnershipTransfer" WHERE "id"='${id}'`)).toBe(
      'guarded',
    );
    // An accepted transfer cannot be left unapplied at commit.
    expect(
      await attempt(
        `UPDATE "GuildOwnershipTransfer" SET "state"='ACCEPTED',"decidedAt"=clock_timestamp(),"decidedByAccountId"="toAccountId","decideReceiptId"="proposeReceiptId" WHERE "id"='${id}'`,
      ),
    ).toBe('guarded');
  });

  it('keeps existing grants and lets the new Founder revoke them', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const editor = await person();
    await grantRow(g.id, editor);
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    await respond(next, g.id, id, 'ACCEPT');
    expect((await edit(editor, g.id, 1, { name: 'Delegate keeps scope' })).guild.revision).toBe(2);
  });

  it('cannot be forged by a direct writer that decides on the recipient’s behalf', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    const forge = (decidedBy: string, receiptColumn: string, decidedAt = 'clock_timestamp()') =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "GuildOwnershipTransfer" SET "state"='ACCEPTED',"decidedAt"=${decidedAt},"decidedByAccountId"=$2,"decideReceiptId"=${receiptColumn} WHERE "id"=$1::uuid`,
          id,
          decidedBy,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "Guild" SET "founderAccountId"=$2 WHERE "id"=$1::uuid`,
          g.id,
          next.accountId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "GuildOwnershipTransfer" SET "appliedAt"=clock_timestamp() WHERE "id"=$1::uuid`,
          id,
        );
      });
    const founderNow = async () =>
      (
        (await db.$queryRawUnsafe(
          `SELECT "founderAccountId" AS f FROM "Guild" WHERE "id"=$1::uuid`,
          g.id,
        )) as { f: string }[]
      )[0].f;
    // The Founder "accepting" for the recipient, or any non-recipient deciding an acceptance.
    await expect(forge(founder.accountId, '"proposeReceiptId"')).rejects.toThrow(
      /GuildOwnershipTransfer/,
    );
    // The recipient named, but the decision is not backed by a recipient's own response receipt.
    await expect(forge(next.accountId, '"proposeReceiptId"')).rejects.toThrow(/Guild/);
    // An acceptance stamped after the proposal's own window closed.
    await expect(
      forge(next.accountId, '"proposeReceiptId"', `"expiresAt"+interval '1 minute'`),
    ).rejects.toThrow(/GuildOwnershipTransfer/);
    expect(await founderNow()).toBe(founder.accountId);
  });
  it('accepts non-canonical (uppercase) ids and commits them in canonical form', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const editor = await person();
    const G = g.id.toUpperCase();
    const proposed = await propose(founder, G, next.accountId, {}, 'p-upper');
    expect(proposed.transfer.guildId).toBe(g.id);
    const done = await respond(next, G, proposed.transfer.id.toUpperCase(), 'ACCEPT', 'a-upper');
    expect(done).toMatchObject({
      status: 'EXECUTED',
      transfer: { id: proposed.transfer.id, state: 'ACCEPTED', applied: true },
    });
    // The same request in canonical form is the same request.
    expect((await respond(next, g.id, proposed.transfer.id, 'ACCEPT', 'a-upper')).status).toBe(
      'REPLAYED',
    );
    expect(await founderOf(g.id)).toBe(next.accountId);
    const issued = await grant(next, {
      guildId: G,
      granteeAccountId: editor.accountId,
      kind: 'WORK',
    });
    expect(issued.grant.guildId).toBe(g.id);
    const revoked = await revoke(next, G, issued.grant.id.toUpperCase(), 'r-upper');
    expect(revoked.grant).toMatchObject({ id: issued.grant.id, guildId: g.id });
    expect(revoked.grant.revokedAt).not.toBeNull();
    expect((await revoke(next, g.id, issued.grant.id, 'r-upper')).status).toBe('REPLAYED');
  });

  it('records an acceptance that crosses the expiry during a slow host hook as expired', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const [{ at }] = await db.$queryRawUnsafe<{ at: Date }[]>(
      `SELECT clock_timestamp()+interval '1500 milliseconds' AS at`,
    );
    const id = (await propose(founder, g.id, next.accountId, { expiresAt: at.toISOString() }))
      .transfer.id;
    const slowHost = {
      allowNewWrites: true,
      authorizeOwnershipTransfer: async () => {
        await new Promise((resolve) => setTimeout(resolve, at.getTime() - Date.now() + 300));
        return true;
      },
    };
    const result = await run((tx) =>
      respondOwnershipTransfer(
        tx,
        cmd(next, { guildId: g.id, transferId: id, decision: 'ACCEPT' }, 'slow'),
        slowHost,
      ),
    );
    expect(result).toMatchObject({
      status: 'EXECUTED',
      transfer: { state: 'EXPIRED', applied: false },
    });
    expect(await founderOf(g.id)).toBe(founder.accountId);
    const events = await db.$queryRawUnsafe<{ eventType: string }[]>(
      `SELECT "eventType" FROM "AuditEvent" WHERE "guildId"=$1 AND "eventType" LIKE 'guild.ownership_%' ORDER BY "occurredAt"`,
      g.id,
    );
    expect(events.map((e) => e.eventType)).toEqual([
      'guild.ownership_proposed.v1',
      'guild.ownership_expired.v1',
    ]);
  });

  it('never makes a Founder of an account holding live treasury or dispute authority in the Guild', async () => {
    const { founder, guild: g } = await guild();
    const treasurer = await person();
    const arbiter = await person();
    const editor = await person();
    const t = await grant(founder, {
      guildId: g.id,
      granteeAccountId: treasurer.accountId,
      kind: 'TREASURY',
    });
    await grant(founder, { guildId: g.id, granteeAccountId: arbiter.accountId, kind: 'DISPUTE' });
    await grant(founder, {
      guildId: g.id,
      granteeAccountId: editor.accountId,
      kind: 'PROFILE',
      fields: ['name'],
    });
    await expect(propose(founder, g.id, treasurer.accountId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(propose(founder, g.id, arbiter.accountId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // A grant issued after the proposal is caught at acceptance; nothing moves.
    const id = (await propose(founder, g.id, editor.accountId, {}, 'p-editor')).transfer.id;
    const late = await grant(founder, {
      guildId: g.id,
      granteeAccountId: editor.accountId,
      kind: 'TREASURY',
    });
    await expect(respond(editor, g.id, id, 'ACCEPT', 'a-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await founderOf(g.id)).toBe(founder.accountId);
    // Once the recipient surrenders the separate authority, the proposal can be accepted.
    await revoke(editor, g.id, late.grant.id);
    expect((await respond(editor, g.id, id, 'ACCEPT', 'a-2')).transfer.applied).toBe(true);
    expect(await founderOf(g.id)).toBe(editor.accountId);
    // A revoked or expired treasury grant is history, not authority.
    await revoke(editor, g.id, t.grant.id);
    expect((await propose(editor, g.id, treasurer.accountId, {}, 'p-t')).transfer.state).toBe(
      'PROPOSED',
    );
  });

  it('lets the former Founder revoke grants they issued after the transfer', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const editor = await person();
    const issued = await grant(founder, {
      guildId: g.id,
      granteeAccountId: editor.accountId,
      kind: 'WORK',
    });
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    await respond(next, g.id, id, 'ACCEPT');
    const revoked = await revoke(founder, g.id, issued.grant.id);
    expect(revoked.grant.revokedAt).not.toBeNull();
  });

  it('records a lapse for DECLINE and WITHDRAW too, with EXECUTED status and state EXPIRED', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const lapse = async (id: string) => {
      await db.$executeRawUnsafe(
        `ALTER TABLE "GuildOwnershipTransfer" DISABLE TRIGGER guild_transfer_guard_v1`,
      );
      try {
        await db.$executeRawUnsafe(
          `UPDATE "GuildOwnershipTransfer" SET "proposedAt"=clock_timestamp()-interval '2 days',"expiresAt"=clock_timestamp()-interval '1 day' WHERE "id"=$1::uuid`,
          id,
        );
      } finally {
        await db.$executeRawUnsafe(
          `ALTER TABLE "GuildOwnershipTransfer" ENABLE TRIGGER guild_transfer_guard_v1`,
        );
      }
    };
    const t1 = (await propose(founder, g.id, next.accountId, {}, 'p-1')).transfer.id;
    await lapse(t1);
    expect(await respond(next, g.id, t1, 'DECLINE')).toMatchObject({
      status: 'EXECUTED',
      transfer: { state: 'EXPIRED', applied: false },
    });
    const t2 = (await propose(founder, g.id, next.accountId, {}, 'p-2')).transfer.id;
    await lapse(t2);
    expect(await respond(founder, g.id, t2, 'WITHDRAW')).toMatchObject({
      status: 'EXECUTED',
      transfer: { state: 'EXPIRED', applied: false },
    });
    expect(await founderOf(g.id)).toBe(founder.accountId);
  });
});
