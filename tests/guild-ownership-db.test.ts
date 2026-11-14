import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import {
  activateGuild,
  editGuildProfile,
  grantGuildRole,
  hasGuildAuthority,
  listPendingOwnershipTransfers,
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
    // A recipient naming a transfer that is not theirs is a stranger to it: the same answer as for any unknown id.
    await expect(
      respond(next, g.id, '00000000-0000-4000-8000-000000000000', 'ACCEPT'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
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

  it('refuses acceptance by a recipient who was suspended after the proposal', async () => {
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
    // Each direct write is refused by its own guard, named by the guard's message; nothing else may be the reason.
    const refused = (sql: string, message: string) =>
      expect(db.$executeRawUnsafe(sql)).rejects.toThrow(message);
    await refused(
      `UPDATE "Guild" SET "founderAccountId"='${next.accountId}' WHERE "id"='${g.id}'`,
      'The Guild Founder changes only through an accepted ownership transfer',
    );
    await refused(
      `UPDATE "GuildOwnershipTransfer" SET "toAccountId"='${founder.accountId}' WHERE "id"='${id}'`,
      'Guild ownership transfer parties and window are immutable',
    );
    await refused(
      `DELETE FROM "GuildOwnershipTransfer" WHERE "id"='${id}'`,
      'Guild ownership transfers require reviewed retention or recovery',
    );
    // An accepted transfer cannot be left unapplied at commit.
    await refused(
      `UPDATE "GuildOwnershipTransfer" SET "state"='ACCEPTED',"decidedAt"=clock_timestamp(),"decidedByAccountId"="toAccountId","decideReceiptId"="proposeReceiptId" WHERE "id"='${id}'`,
      'An accepted Guild ownership transfer must be applied to the Guild',
    );
  });

  it('lets only the recipient have accepted or declined and only the proposer have withdrawn, for a direct writer too', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const stranger = await person();
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    const decide = (state: string, by: string) =>
      db.$executeRawUnsafe(
        `UPDATE "GuildOwnershipTransfer" SET "state"='${state}',"decidedAt"=clock_timestamp(),"decidedByAccountId"='${by}',"decideReceiptId"="proposeReceiptId" WHERE "id"='${id}'`,
      );
    const decider = 'GuildOwnershipTransfer_decider_check';
    // The recipient cannot record a withdrawal, nor can a stranger; the proposer cannot record a decline.
    await expect(decide('WITHDRAWN', next.accountId)).rejects.toThrow(decider);
    await expect(decide('WITHDRAWN', stranger.accountId)).rejects.toThrow(decider);
    await expect(decide('DECLINED', founder.accountId)).rejects.toThrow(decider);
    await expect(decide('DECLINED', stranger.accountId)).rejects.toThrow(decider);
    const [{ state }] = await db.$queryRawUnsafe<{ state: string }[]>(
      `SELECT "state" FROM "GuildOwnershipTransfer" WHERE "id"=$1::uuid`,
      id,
    );
    expect(state).toBe('PROPOSED');
  });

  it('keeps a delegate’s existing grant, and its edit scope, across the transfer', async () => {
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
      'GuildOwnershipTransfer_decider_check',
    );
    // The recipient named, but the decision is not backed by a recipient's own response receipt.
    await expect(forge(next.accountId, '"proposeReceiptId"')).rejects.toThrow(
      'A Guild ownership transfer decision needs the deciding account',
    );
    // An acceptance stamped after the proposal's own window closed.
    await expect(
      forge(next.accountId, '"proposeReceiptId"', `"expiresAt"+interval '1 minute'`),
    ).rejects.toThrow('GuildOwnershipTransfer_timing_check');
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
    let hookCalls = 0;
    const slowHost = {
      allowNewWrites: true,
      authorizeOwnershipTransfer: async () => {
        hookCalls++;
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
    // On a slow runner the proposal may already have lapsed before the hook; the crossing is only covered if it ran.
    expect(hookCalls, 'the host hook ran, so the decision crossed expiresAt').toBe(1);
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
    const id = (await propose(founder, g.id, editor.accountId, {}, 'p-editor')).transfer.id;
    // DEC-2026-11-13-04 d: the application refuses the grant to an open proposal's recipient up front.
    await expect(
      grant(founder, { guildId: g.id, granteeAccountId: editor.accountId, kind: 'TREASURY' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A grant that still reaches the table after the proposal (a direct writer) is caught at acceptance; nothing moves.
    const [late] = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","grantedByAccountId") VALUES ($1::uuid,$2,'TREASURY',ARRAY[]::text[],$3) RETURNING "id"::text`,
      g.id,
      editor.accountId,
      founder.accountId,
    );
    await expect(respond(editor, g.id, id, 'ACCEPT', 'a-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await founderOf(g.id)).toBe(founder.accountId);
    // Once the recipient surrenders the separate authority, the proposal can be accepted.
    await revoke(editor, g.id, late.id);
    expect((await respond(editor, g.id, id, 'ACCEPT', 'a-2')).transfer.applied).toBe(true);
    expect(await founderOf(g.id)).toBe(editor.accountId);
    // A revoked or expired treasury grant is history, not authority.
    await revoke(editor, g.id, t.grant.id);
    expect((await propose(editor, g.id, treasurer.accountId, {}, 'p-t')).transfer.state).toBe(
      'PROPOSED',
    );
  });

  it('DEC-2026-11-13-03 a: a former Founder cannot revoke what they issued; grants stay in force until the new Founder or the grantee revokes them', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const holders = [await person(), await person(), await person(), await person()];
    const kinds = ['WORK', 'TREASURY', 'DISPUTE', 'PROFILE'] as const;
    const issued = [];
    for (const [i, kind] of kinds.entries())
      issued.push(
        await grant(founder, {
          guildId: g.id,
          granteeAccountId: holders[i].accountId,
          kind,
          ...(kind === 'PROFILE' ? { fields: ['name'] } : {}),
        }),
      );
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    await respond(next, g.id, id, 'ACCEPT');
    // FORBIDDEN, also when the same key is sent again, and nothing is revoked.
    for (const [i, made] of issued.entries())
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(revoke(founder, g.id, made.grant.id, 'former-' + i)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
    const live = async () =>
      (
        await db.$queryRawUnsafe<{ id: string; revoked: boolean }[]>(
          `SELECT "id"::text,"revokedAt" IS NOT NULL AS revoked FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid`,
          g.id,
        )
      ).filter((r) => !r.revoked).length;
    expect(await live()).toBe(4);
    for (const [i, kind] of kinds.entries())
      expect(await run((tx) => hasGuildAuthority(tx, holders[i].accountId, g.id, kind))).toBe(true);
    // The new Founder revokes any of them, and a grantee still surrenders their own.
    expect((await revoke(next, g.id, issued[1].grant.id)).grant.revokedAt).not.toBeNull();
    expect((await revoke(holders[2], g.id, issued[2].grant.id)).grant.revokedAt).not.toBeNull();
    expect((await revoke(next, g.id, issued[0].grant.id)).grant.revokedAt).not.toBeNull();
    expect(await live()).toBe(1);
    // A revoked grant answers the former Founder the same: they are not involved any more.
    await expect(revoke(founder, g.id, issued[0].grant.id, 'former-again')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // The former Founder cannot issue new roles either.
    await expect(
      grant(founder, { guildId: g.id, granteeAccountId: holders[0].accountId, kind: 'WORK' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('DEC-2026-11-13-03 a: a former Founder holding a new delegating grant revokes only what that grant covers', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const nameHolder = await person();
    const descriptionHolder = await person();
    const workHolder = await person();
    const given = (who: GuildActor, extra: Record<string, unknown>) =>
      grant(founder, { guildId: g.id, granteeAccountId: who.accountId, ...extra });
    const byName = await given(nameHolder, { kind: 'PROFILE', fields: ['name'] });
    const byDescription = await given(descriptionHolder, {
      kind: 'PROFILE',
      fields: ['description'],
    });
    const work = await given(workHolder, { kind: 'WORK' });
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    await respond(next, g.id, id, 'ACCEPT');
    await grant(next, {
      guildId: g.id,
      granteeAccountId: founder.accountId,
      kind: 'PROFILE',
      fields: ['name'],
      canDelegate: true,
    });
    // The literal rule: a live delegating PROFILE grant covering the grant's fields. Nothing else widens it.
    await expect(revoke(founder, g.id, byDescription.grant.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(revoke(founder, g.id, work.grant.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await revoke(founder, g.id, byName.grant.id)).grant.revokedAt).not.toBeNull();
  });

  it('DEC-2026-11-13-03 b: WITHDRAW and DECLINE work with the flag off and writes disabled; PROPOSE and ACCEPT stay gated', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const stranger = await person();
    await expect(propose(founder, g.id, next.accountId, {}, 'p-off', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    const toWithdraw = (await propose(founder, g.id, next.accountId, {}, 'p-w')).transfer.id;
    await expect(respond(next, g.id, toWithdraw, 'ACCEPT', 'a-off', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    // Still bound to the right party with writes off.
    for (const [who, decision] of [
      [stranger, 'WITHDRAW'],
      [stranger, 'DECLINE'],
      [next, 'WITHDRAW'],
      [founder, 'DECLINE'],
    ] as const)
      await expect(
        respond(who, g.id, toWithdraw, decision, undefined, false),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const withdrawn = await respond(founder, g.id, toWithdraw, 'WITHDRAW', 'w-off', false);
    expect(withdrawn).toMatchObject({
      status: 'EXECUTED',
      transfer: { state: 'WITHDRAWN', applied: false },
    });
    expect((await respond(founder, g.id, toWithdraw, 'WITHDRAW', 'w-off', false)).status).toBe(
      'REPLAYED',
    );
    const toDecline = (await propose(founder, g.id, next.accountId, {}, 'p-d')).transfer.id;
    const declined = await respond(next, g.id, toDecline, 'DECLINE', 'd-off', false);
    expect(declined).toMatchObject({
      status: 'EXECUTED',
      transfer: { state: 'DECLINED', applied: false },
    });
    expect(await founderOf(g.id)).toBe(founder.accountId);
    await expect(respond(next, g.id, toDecline, 'DECLINE', 'd-again', false)).rejects.toMatchObject(
      { code: 'REVISION_CONFLICT' },
    );
  });

  it('#294-11: a lapse recorded by the next proposal is backed by that proposal; a direct writer cannot attribute it to anything else', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const first = (await propose(founder, g.id, next.accountId, {}, 'p-1')).transfer.id;
    await db.$executeRawUnsafe(
      `ALTER TABLE "GuildOwnershipTransfer" DISABLE TRIGGER guild_transfer_guard_v1`,
    );
    try {
      await db.$executeRawUnsafe(
        `UPDATE "GuildOwnershipTransfer" SET "proposedAt"=clock_timestamp()-interval '2 days',"expiresAt"=clock_timestamp()-interval '1 day' WHERE "id"=$1::uuid`,
        first,
      );
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "GuildOwnershipTransfer" ENABLE TRIGGER guild_transfer_guard_v1`,
      );
    }
    // A direct writer records the lapse against the lapsed proposal's own proposing receipt: no successor exists.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "GuildOwnershipTransfer" SET "state"='EXPIRED',"decidedAt"=clock_timestamp(),"decidedByAccountId"="fromAccountId","decideReceiptId"="proposeReceiptId" WHERE "id"=$1::uuid`,
        first,
      ),
    ).rejects.toThrow('A Guild ownership transfer decision needs the deciding account');
    // The proposal that legitimately records it creates the successor, and the lapse points at that receipt.
    const second = (await propose(founder, g.id, next.accountId, {}, 'p-2')).transfer.id;
    const [row] = await db.$queryRawUnsafe<
      { state: string; by: string; kind: string; successor: string }[]
    >(
      `SELECT o."state",o."decidedByAccountId" AS by,c."commandKind" AS kind,c."resultRef" AS successor
       FROM "GuildOwnershipTransfer" o JOIN "CommandReceipt" c ON c."id"=o."decideReceiptId" WHERE o."id"=$1::uuid`,
      first,
    );
    expect(row).toEqual({
      state: 'EXPIRED',
      by: founder.accountId,
      kind: 'ProposeOwnershipTransfer',
      successor: second,
    });
  });

  it('#438-1: a lapse cannot be attributed to a successor proposed before the lapsed transfer expired', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const older = (await propose(founder, g.id, next.accountId, {}, 'p-1')).transfer.id;
    expect((await respond(next, g.id, older, 'DECLINE', 'd-1')).transfer.state).toBe('DECLINED');
    const lapsed = (await propose(founder, g.id, next.accountId, {}, 'p-2')).transfer.id;
    // Backdate both: the earlier proposal ends before the later one expires, so it is no successor of the later one.
    await db.$executeRawUnsafe(
      `ALTER TABLE "GuildOwnershipTransfer" DISABLE TRIGGER guild_transfer_guard_v1`,
    );
    try {
      await db.$executeRawUnsafe(
        `UPDATE "GuildOwnershipTransfer" SET "proposedAt"=clock_timestamp()-interval '10 days',"expiresAt"=clock_timestamp()-interval '9 days' WHERE "id"=$1::uuid`,
        older,
      );
      await db.$executeRawUnsafe(
        `UPDATE "GuildOwnershipTransfer" SET "proposedAt"=clock_timestamp()-interval '5 days',"expiresAt"=clock_timestamp()-interval '1 day' WHERE "id"=$1::uuid`,
        lapsed,
      );
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "GuildOwnershipTransfer" ENABLE TRIGGER guild_transfer_guard_v1`,
      );
    }
    // A direct writer attributes the lapse to the Founder's older proposal, which also created a transfer (`older`).
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "GuildOwnershipTransfer" t SET "state"='EXPIRED',"decidedAt"=clock_timestamp(),"decidedByAccountId"=t."fromAccountId","decideReceiptId"=o."proposeReceiptId" FROM "GuildOwnershipTransfer" o WHERE t."id"=$1::uuid AND o."id"=$2::uuid`,
        lapsed,
        older,
      ),
    ).rejects.toThrow('A Guild ownership transfer decision needs the deciding account');
  });

  it('#294-11: an accept whose transfer is decided meanwhile is refused with REVISION_CONFLICT, not an unspecific storage error', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const id = (await propose(founder, g.id, next.accountId, {}, 'p-1')).transfer.id;
    // A misbehaving host hook withdraws the transfer through the same transaction, so the accept update finds no
    // pending row.
    const meddling = {
      allowNewWrites: true,
      authorizeOwnershipTransfer: async (tx: {
        query: (sql: string, params: unknown[]) => Promise<unknown>;
      }) => {
        await tx.query(
          `UPDATE "GuildOwnershipTransfer" SET "state"='WITHDRAWN',"decidedAt"=clock_timestamp(),"decidedByAccountId"="fromAccountId","decideReceiptId"="proposeReceiptId" WHERE "id"=$1::uuid`,
          [id],
        );
        return true;
      },
    };
    await expect(
      run((tx) =>
        respondOwnershipTransfer(
          tx,
          cmd(next, { guildId: g.id, transferId: id, decision: 'ACCEPT' }, 'a-1'),
          meddling as never,
        ),
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await founderOf(g.id)).toBe(founder.accountId);
    // The refusal rolls the whole transaction back: the hook's withdrawal is undone, so the transfer is still
    // pending with no decision recorded and the accept left no receipt behind.
    const [row] = await db.$queryRawUnsafe<
      { state: string; decidedAt: Date | null; decidedBy: string | null; receipt: string | null }[]
    >(
      `SELECT "state","decidedAt","decidedByAccountId" AS "decidedBy","decideReceiptId"::text AS receipt FROM "GuildOwnershipTransfer" WHERE "id"=$1::uuid`,
      id,
    );
    expect(row).toEqual({ state: 'PROPOSED', decidedAt: null, decidedBy: null, receipt: null });
    const accepts = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "CommandReceipt" WHERE "actorId"=$1 AND "commandKind"='RespondOwnershipTransfer'`,
      next.accountId,
    );
    expect(accepts[0].n).toBe(0);
    // And the transfer is still answerable afterwards.
    expect((await respond(next, g.id, id, 'ACCEPT', 'a-2')).transfer.state).toBe('ACCEPTED');
  });

  it('#438-3: the contract-breaking host hook case logs one operator line of ids and fixed words, nothing else', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const id = (await propose(founder, g.id, next.accountId, {}, 'p-1')).transfer.id;
    const meddling = {
      allowNewWrites: true,
      authorizeOwnershipTransfer: async (tx: {
        query: (sql: string, params: unknown[]) => Promise<unknown>;
      }) => {
        await tx.query(
          `UPDATE "GuildOwnershipTransfer" SET "state"='WITHDRAWN',"decidedAt"=clock_timestamp(),"decidedByAccountId"="fromAccountId","decideReceiptId"="proposeReceiptId" WHERE "id"=$1::uuid`,
          [id],
        );
        return true;
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        run((tx) =>
          respondOwnershipTransfer(
            tx,
            cmd(next, { guildId: g.id, transferId: id, decision: 'ACCEPT' }, 'idem-key-438-3'),
            meddling as never,
          ),
        ),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(JSON.parse(line)).toEqual({
        event: 'guild-transfer-decision-conflict',
        code: 'REVISION_CONFLICT',
        guildId: g.id,
        transferId: id,
        decision: 'ACCEPT',
      });
      // No actor, session or receipt material reaches the line.
      for (const secret of [next.accountId, founder.accountId, next.sessionHash, 'idem-key-438-3'])
        expect(line).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
    // An ordinary stale accept (transfer already decided before the call) is a normal refusal and logs nothing.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await respond(next, g.id, id, 'ACCEPT', 'a-2');
      await expect(respond(next, g.id, id, 'ACCEPT', 'a-3')).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      expect(quiet).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  it('#294-11: the decision CHECK refuses every decided state missing any part of its record, and a pending one carrying a decision', async () => {
    const { founder, guild: g } = await guild();
    const next = await person();
    const id = (await propose(founder, g.id, next.accountId)).transfer.id;
    // Each state's own valid values for the other constraints (who may decide, when), so only the CHECK under test
    // can refuse the row.
    const valid = {
      ACCEPTED: { at: '"proposedAt"', by: '"toAccountId"' },
      DECLINED: { at: '"proposedAt"', by: '"toAccountId"' },
      WITHDRAWN: { at: '"proposedAt"', by: '"fromAccountId"' },
      EXPIRED: { at: `"expiresAt"+interval '1 second'`, by: '"fromAccountId"' },
    } as const;
    for (const [state, { at, by }] of Object.entries(valid))
      for (const missing of ['decidedAt', 'decidedByAccountId', 'decideReceiptId']) {
        const set = [
          `"decidedAt"=${missing === 'decidedAt' ? 'NULL' : at}`,
          `"decidedByAccountId"=${missing === 'decidedByAccountId' ? 'NULL' : by}`,
          `"decideReceiptId"=${missing === 'decideReceiptId' ? 'NULL' : '"proposeReceiptId"'}`,
        ].join(',');
        await expect(
          db.$executeRawUnsafe(
            `UPDATE "GuildOwnershipTransfer" SET "state"='${state}',${set} WHERE "id"=$1::uuid`,
            id,
          ),
          `${state} without ${missing}`,
        ).rejects.toThrow('GuildOwnershipTransfer_decision_check');
      }
    // A pending transfer carries no decision (the guard trigger would refuse first, so a direct writer without it).
    await db.$executeRawUnsafe(
      `ALTER TABLE "GuildOwnershipTransfer" DISABLE TRIGGER guild_transfer_guard_v1`,
    );
    try {
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "GuildOwnershipTransfer" SET "decideReceiptId"="proposeReceiptId" WHERE "id"=$1::uuid`,
          id,
        ),
      ).rejects.toThrow('GuildOwnershipTransfer_decision_check');
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "GuildOwnershipTransfer" ENABLE TRIGGER guild_transfer_guard_v1`,
      );
    }
    // The complete record passes the CHECK (a later guard may still judge it, but never this constraint).
    const complete = db.$executeRawUnsafe(
      `UPDATE "GuildOwnershipTransfer" SET "state"='DECLINED',"decidedAt"=clock_timestamp(),"decidedByAccountId"="toAccountId","decideReceiptId"="proposeReceiptId" WHERE "id"=$1::uuid`,
      id,
    );
    await complete.then(
      () => undefined,
      (error: unknown) =>
        expect(String(error)).not.toContain('GuildOwnershipTransfer_decision_check'),
    );
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

  it('#355-1: propose and respond judge standing before the Guild lock and tell a stranger nothing', async () => {
    const { founder, guild: g } = await guild('prelock-t');
    const next = await person();
    const stranger = await person();
    const transferId = (await propose(founder, g.id, next.accountId, {}, 'p-pre')).transfer.id;
    // Hold the Guild row as a competing writer would; a refused account must not queue behind it.
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(
      async (t) => {
        await t.$queryRawUnsafe('SELECT 1 FROM "Guild" WHERE "id"=$1::uuid FOR UPDATE', g.id);
        locked();
        await held;
      },
      { timeout: 30000 },
    );
    await ready;
    const outcome = (work: Promise<unknown>) =>
      Promise.race([
        work.then(
          () => 'EXECUTED',
          (e: { code?: string }) => e.code ?? 'ERROR',
        ),
        new Promise<string>((r) => setTimeout(() => r('BLOCKED'), 3000)),
      ]);
    try {
      const unknownGuild = crypto.randomUUID();
      const unknownTransfer = crypto.randomUUID();
      // A stranger gets one answer for a real Guild, a missing Guild, a real transfer and a missing one.
      expect(await outcome(propose(stranger, g.id, next.accountId, {}, 's-1'))).toBe('FORBIDDEN');
      expect(await outcome(propose(stranger, unknownGuild, next.accountId, {}, 's-2'))).toBe(
        'FORBIDDEN',
      );
      for (const decision of ['ACCEPT', 'DECLINE', 'WITHDRAW']) {
        expect(await outcome(respond(stranger, g.id, transferId, decision, 's-3' + decision))).toBe(
          'FORBIDDEN',
        );
        expect(
          await outcome(respond(stranger, g.id, unknownTransfer, decision, 's-4' + decision)),
        ).toBe('FORBIDDEN');
        expect(
          await outcome(
            respond(stranger, unknownGuild, unknownTransfer, decision, 's-5' + decision),
          ),
        ).toBe('FORBIDDEN');
      }
      // A party with the wrong role is refused without the lock too: the recipient cannot withdraw, the Founder cannot accept.
      expect(await outcome(respond(next, g.id, transferId, 'WITHDRAW', 'w-1'))).toBe('FORBIDDEN');
      expect(await outcome(respond(founder, g.id, transferId, 'ACCEPT', 'w-2'))).toBe('FORBIDDEN');
      // A recipient naming a transfer that is not theirs is turned away without waiting.
      expect(await outcome(respond(next, g.id, unknownTransfer, 'ACCEPT', 'w-3'))).toBe(
        'FORBIDDEN',
      );
    } finally {
      release();
      await holder;
    }
    // The Founder naming a missing transfer still learns it is missing; the real parties still act.
    await expect(
      respond(founder, g.id, crypto.randomUUID(), 'WITHDRAW', 'f-1'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await respond(next, g.id, transferId, 'ACCEPT', 'ok-1')).transfer.applied).toBe(true);
  });

  it('#320-2: only unrevoked, unexpired treasury or dispute grants bar a recipient; a future-dated one counts', async () => {
    const { founder, guild: g } = await guild('separate-kinds');
    const lapsed = await person();
    const upcoming = await person();
    const arbiter = await person();
    const row = (who: GuildActor, kind: string, from: string, until: string | null) =>
      db.$executeRawUnsafe(
        `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","validFrom","expiresAt","grantedByAccountId") VALUES ($1::uuid,$2,$3,ARRAY[]::text[],clock_timestamp()+$4::interval,CASE WHEN $5::text IS NULL THEN NULL ELSE clock_timestamp()+$5::interval END,$6)`,
        g.id,
        who.accountId,
        kind,
        from,
        until,
        founder.accountId,
      );
    await row(lapsed, 'TREASURY', '-2 hours', '-1 hour');
    await row(upcoming, 'DISPUTE', '1 hour', null);
    // An expired grant is history: the transfer is allowed and accepted.
    const ok = (await propose(founder, g.id, lapsed.accountId, {}, 'p-lapsed')).transfer.id;
    expect((await respond(lapsed, g.id, ok, 'ACCEPT', 'a-lapsed')).transfer.applied).toBe(true);
    // A grant that has not started yet would be live under the new Founder, so it bars the proposal.
    await expect(propose(lapsed, g.id, upcoming.accountId, {}, 'p-up')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // A dispute grant issued after the proposal is caught at acceptance, like a treasury one.
    const id = (await propose(lapsed, g.id, arbiter.accountId, {}, 'p-arb')).transfer.id;
    await row(arbiter, 'DISPUTE', '-1 minute', null);
    await expect(respond(arbiter, g.id, id, 'ACCEPT', 'a-arb')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await founderOf(g.id)).toBe(lapsed.accountId);
  });

  describe('reading a pending transfer (#294 NOTE)', () => {
    const page = (actor: GuildActor, limit?: number) =>
      run((tx) => listPendingOwnershipTransfers(tx, actor, limit));
    const pending = (actor: GuildActor) => page(actor).then((r) => r.transfers);

    it('shows an open proposal to its recipient and its proposer, and to nobody else', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const stranger = await person();
      const delegate = await person();
      await grantRow(g.id, delegate);
      const { transfer } = await propose(founder, g.id, next.accountId, {}, 'p-1');
      // The proposer is not disclosed to an unsolicited recipient (the Founder id is redacted for non-authority callers).
      expect(await pending(next)).toEqual([{ ...transfer, fromAccountId: null }]);
      expect(await pending(founder)).toEqual([transfer]);
      // Neither an unrelated account nor a profile delegate of the Guild learns that a proposal exists.
      expect(await pending(stranger)).toEqual([]);
      expect(await pending(delegate)).toEqual([]);
    });

    it('shows no decided or lapsed proposal, and never a recipient the proposal was not made to', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const other = await person();
      const { transfer } = await propose(founder, g.id, next.accountId, {}, 'p-1');
      await respond(next, g.id, transfer.id, 'DECLINE', 'd-1');
      expect(await pending(next)).toEqual([]);
      expect(await pending(founder)).toEqual([]);
      const second = (await propose(founder, g.id, other.accountId, {}, 'p-2')).transfer;
      expect(await pending(next)).toEqual([]);
      expect(await pending(other)).toEqual([{ ...second, fromAccountId: null }]);
      // A proposal past its window is lapsed, even before anything records it.
      await db.$executeRawUnsafe(
        `ALTER TABLE "GuildOwnershipTransfer" DISABLE TRIGGER guild_transfer_guard_v1`,
      );
      try {
        await db.$executeRawUnsafe(
          `UPDATE "GuildOwnershipTransfer" SET "proposedAt"=clock_timestamp()-interval '2 days',"expiresAt"=clock_timestamp()-interval '1 day' WHERE "id"=$1::uuid`,
          second.id,
        );
      } finally {
        await db.$executeRawUnsafe(
          `ALTER TABLE "GuildOwnershipTransfer" ENABLE TRIGGER guild_transfer_guard_v1`,
        );
      }
      expect(await pending(other)).toEqual([]);
      expect(await pending(founder)).toEqual([]);
    });

    it('reads with a live session only: unknown, suspended or session-less callers are refused, and the read writes nothing', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      await propose(founder, g.id, next.accountId, {}, 'p-1');
      const forged = { accountId: next.accountId, sessionHash: 'b'.repeat(64) };
      await expect(pending(forged)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await expect(
        pending({ accountId: next.accountId, sessionHash: 'nope' }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await db.user.update({ where: { id: next.accountId }, data: { suspended: true } });
      await expect(pending(next)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
      const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "GuildOwnershipTransfer" WHERE "state"='PROPOSED'`,
      );
      expect(n).toBe(1);
    });

    it('#448: a recipient who accepts or declines is never told who proposed; the proposer still is', async () => {
      const a = await guild('synthetic-guild-a');
      const b = await guild('synthetic-guild-b');
      const c = await guild('synthetic-guild-c');
      const next = await person();
      const decline = (await propose(a.founder, a.guild.id, next.accountId, {}, 'da')).transfer;
      const accept = (await propose(b.founder, b.guild.id, next.accountId, {}, 'db')).transfer;
      const withdraw = (await propose(c.founder, c.guild.id, next.accountId, {}, 'dc')).transfer;
      const declined = await respond(next, a.guild.id, decline.id, 'DECLINE', 'r-d');
      expect(declined.transfer).toMatchObject({ state: 'DECLINED', fromAccountId: null });
      const accepted = await respond(next, b.guild.id, accept.id, 'ACCEPT', 'r-a');
      expect(accepted.transfer).toMatchObject({
        state: 'ACCEPTED',
        applied: true,
        fromAccountId: null,
      });
      // The replay of either decision is redacted the same way.
      expect((await respond(next, a.guild.id, decline.id, 'DECLINE', 'r-d')).transfer).toEqual(
        declined.transfer,
      );
      expect((await respond(next, b.guild.id, accept.id, 'ACCEPT', 'r-a')).transfer).toEqual(
        accepted.transfer,
      );
      // The proposing Founder withdrawing is the proposer, so their own id stays.
      expect(
        (await respond(c.founder, c.guild.id, withdraw.id, 'WITHDRAW', 'r-w')).transfer,
      ).toMatchObject({ state: 'WITHDRAWN', fromAccountId: c.founder.accountId });
      // Neither response leaks the proposer anywhere in its serialized form.
      for (const view of [declined, accepted])
        expect(JSON.stringify(view)).not.toContain(a.founder.accountId);
      expect(JSON.stringify(accepted)).not.toContain(b.founder.accountId);
    });

    it('flags a page cut short instead of silently dropping proposals, and refuses a bad page size', async () => {
      const a = await guild('synthetic-guild-a');
      const b = await guild('synthetic-guild-b');
      const next = await person();
      await propose(a.founder, a.guild.id, next.accountId, {}, 'pa');
      await propose(b.founder, b.guild.id, next.accountId, {}, 'pb');
      const all = await page(next);
      expect(all.transfers).toHaveLength(2);
      expect(all.truncated).toBe(false);
      const cut = await page(next, 1);
      expect(cut.transfers).toHaveLength(1);
      expect(cut.truncated).toBe(true);
      expect((await page(next, 2)).truncated).toBe(false);
      for (const bad of [0, 51, 1.5, -1])
        await expect(page(next, bad)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('lets the recipient accept the proposal it found by reading, with no id passed out of band', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      await propose(founder, g.id, next.accountId, {}, 'p-1');
      const [found] = await pending(next);
      const accepted = await respond(next, found.guildId, found.id, 'ACCEPT', 'a-1');
      expect(accepted.transfer).toMatchObject({ state: 'ACCEPTED', applied: true });
      expect(await pending(next)).toEqual([]);
    });
  });

  describe('an acceptance racing other Guild commands (the Guild row serializes them)', () => {
    const outcome = (work: Promise<unknown>) =>
      work.then(
        () => 'OK',
        (e: { code?: string }) => e.code ?? 'ERROR',
      );
    const rounds = [1, 2, 3, 4];
    const stateOf = async (id: string) =>
      (
        await db.$queryRawUnsafe<{ state: string }[]>(
          `SELECT "state" FROM "GuildOwnershipTransfer" WHERE "id"=$1::uuid`,
          id,
        )
      )[0].state;

    it('accept vs withdraw: exactly one decision wins and the Founder matches it', async () => {
      for (const round of rounds) {
        const { founder, guild: g } = await guild('race-withdraw-' + round);
        const next = await person();
        const id = (await propose(founder, g.id, next.accountId)).transfer.id;
        const [accepted, withdrawn] = await Promise.all([
          outcome(respond(next, g.id, id, 'ACCEPT', 'acc-' + round)),
          outcome(respond(founder, g.id, id, 'WITHDRAW', 'wd-' + round)),
        ]);
        if (accepted === 'OK') {
          // The accept won: the former Founder can no longer withdraw.
          expect(withdrawn).toBe('FORBIDDEN');
          expect(await stateOf(id)).toBe('ACCEPTED');
          expect(await founderOf(g.id)).toBe(next.accountId);
        } else {
          expect([accepted, withdrawn]).toEqual(['REVISION_CONFLICT', 'OK']);
          expect(await stateOf(id)).toBe('WITHDRAWN');
          expect(await founderOf(g.id)).toBe(founder.accountId);
        }
      }
    });

    it('accept vs edit: the edit lands under the old Founder or is refused as the former Founder, never both Founders', async () => {
      for (const round of rounds) {
        const { founder, guild: g } = await guild('race-edit-' + round);
        const next = await person();
        const id = (await propose(founder, g.id, next.accountId)).transfer.id;
        const [accepted, edited] = await Promise.all([
          outcome(respond(next, g.id, id, 'ACCEPT', 'acc-' + round)),
          outcome(edit(founder, g.id, 1, { name: 'Raced ' + round }, 'edit-' + round)),
        ]);
        expect(accepted).toBe('OK');
        expect(await founderOf(g.id)).toBe(next.accountId);
        const managed = await run((tx) => readManagedGuild(tx, next, g.id));
        if (edited === 'OK') expect(managed.guild).toMatchObject({ revision: 2 });
        else {
          expect(edited).toBe('FORBIDDEN');
          expect(managed.guild).toMatchObject({ revision: 1 });
        }
        // The new Founder continues from whatever revision the race left.
        const after = await edit(next, g.id, managed.guild.revision, { name: 'After ' + round });
        expect(after.guild.name).toBe('After ' + round);
      }
    });

    it('accept vs a treasury grant to the recipient: the new Founder never holds treasury authority', async () => {
      for (const round of rounds) {
        const { founder, guild: g } = await guild('race-grant-' + round);
        const next = await person();
        const id = (await propose(founder, g.id, next.accountId)).transfer.id;
        const [accepted, granted] = await Promise.all([
          outcome(respond(next, g.id, id, 'ACCEPT', 'acc-' + round)),
          outcome(
            grant(
              founder,
              { guildId: g.id, granteeAccountId: next.accountId, kind: 'TREASURY' },
              'grant-' + round,
            ),
          ),
        ]);
        const [{ live }] = await db.$queryRawUnsafe<{ live: number }[]>(
          `SELECT count(*)::int AS live FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid AND "granteeAccountId"=$2 AND "kind"='TREASURY' AND "revokedAt" IS NULL`,
          g.id,
          next.accountId,
        );
        if (granted === 'OK') {
          // The grant won, so the acceptance is refused and the Founder is unchanged.
          expect(accepted).toBe('FORBIDDEN');
          expect(live).toBe(1);
          expect(await founderOf(g.id)).toBe(founder.accountId);
        } else {
          // The accept won, so the former Founder cannot issue treasury authority to the new Founder.
          expect([accepted, granted]).toEqual(['OK', 'FORBIDDEN']);
          expect(live).toBe(0);
          expect(await founderOf(g.id)).toBe(next.accountId);
        }
      }
    });

    it('accept vs a second proposal: one transfer is decided and no second proposal is left open', async () => {
      for (const round of rounds) {
        const { founder, guild: g } = await guild('race-propose-' + round);
        const next = await person();
        const third = await person();
        const id = (await propose(founder, g.id, next.accountId)).transfer.id;
        const [accepted, proposed] = await Promise.all([
          outcome(respond(next, g.id, id, 'ACCEPT', 'acc-' + round)),
          outcome(propose(founder, g.id, third.accountId, {}, 'again-' + round)),
        ]);
        expect(accepted).toBe('OK');
        // Whichever ran second sees the other's effect: a pending proposal, or a Founder that changed.
        expect(['TRANSFER_PENDING', 'FORBIDDEN']).toContain(proposed);
        expect(await founderOf(g.id)).toBe(next.accountId);
        const rows = await db.$queryRawUnsafe<{ state: string }[]>(
          `SELECT "state" FROM "GuildOwnershipTransfer" WHERE "guildId"=$1::uuid`,
          g.id,
        );
        expect(rows).toEqual([{ state: 'ACCEPTED' }]);
      }
    });
  });

  describe('DEC-2026-11-14-03: acceptance re-checks that the proposing Founder is not suspended', () => {
    const suspend = (who: GuildActor, suspended = true) =>
      db.$executeRawUnsafe(
        `UPDATE "User" SET "suspended"=$2::boolean WHERE "id"=$1`,
        who.accountId,
        suspended,
      );
    const stateOf = async (id: string) =>
      (
        await db.$queryRawUnsafe<{ state: string }[]>(
          `SELECT "state" FROM "GuildOwnershipTransfer" WHERE "id"=$1::uuid`,
          id,
        )
      )[0].state;

    it('refuses acceptance while the proposer is suspended, leaves the proposal PROPOSED and accepts once the suspension is lifted', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const id = (await propose(founder, g.id, next.accountId)).transfer.id;
      await suspend(founder);
      await expect(respond(next, g.id, id, 'ACCEPT', 'acc-1')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await stateOf(id)).toBe('PROPOSED');
      expect(await founderOf(g.id)).toBe(founder.accountId);
      await suspend(founder, false);
      const accepted = await respond(next, g.id, id, 'ACCEPT', 'acc-2');
      expect(accepted.transfer).toMatchObject({ state: 'ACCEPTED', applied: true });
      expect(await founderOf(g.id)).toBe(next.accountId);
    });

    it('lets the recipient decline while the proposer is suspended, and gives the suspended Founder no power to withdraw', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const id = (await propose(founder, g.id, next.accountId)).transfer.id;
      await suspend(founder);
      await expect(respond(founder, g.id, id, 'WITHDRAW', 'wd-1')).rejects.toMatchObject({
        code: 'ACCOUNT_RESTRICTED',
      });
      expect(await stateOf(id)).toBe('PROPOSED');
      const declined = await respond(next, g.id, id, 'DECLINE', 'dec-1');
      expect(declined.transfer.state).toBe('DECLINED');
      expect(await founderOf(g.id)).toBe(founder.accountId);
    });

    it('an unsuspended proposer does not affect acceptance (regression)', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const id = (await propose(founder, g.id, next.accountId)).transfer.id;
      expect((await respond(next, g.id, id, 'ACCEPT')).transfer.applied).toBe(true);
    });

    /** Waits until some other backend is blocked on a lock while running a statement containing `fragment`. */
    const waitForLockWaiter = async (fragment: string, timeoutMs = 10000) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const rows = await db.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0`,
          fragment,
        );
        if (rows[0].n > 0) return;
        if (Date.now() > until) throw new Error('no backend waited on a lock for: ' + fragment);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const acceptWaiter = 'FROM "User" WHERE "id"=$1 FOR SHARE';

    it('serializes a suspension in another transaction with the acceptance: the later sees the earlier', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const id = (await propose(founder, g.id, next.accountId)).transfer.id;
      let accepting: Promise<unknown> | undefined;
      let settled = false;
      // The suspension is written but not yet committed when the acceptance starts: the acceptance must wait for it
      // (the proposer's row is read FOR SHARE) and then see the suspension.
      await db.$transaction(async (t) => {
        await t.$executeRawUnsafe(
          `UPDATE "User" SET "suspended"=true WHERE "id"=$1`,
          founder.accountId,
        );
        accepting = respond(next, g.id, id, 'ACCEPT', 'acc-race').then(
          (v) => ((settled = true), v),
          (e) => {
            settled = true;
            throw e;
          },
        );
        accepting.catch(() => undefined);
        await waitForLockWaiter(acceptWaiter);
        expect(settled).toBe(false);
      });
      await expect(accepting).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await stateOf(id)).toBe('PROPOSED');
      expect(await founderOf(g.id)).toBe(founder.accountId);
    });

    it('an acceptance that holds its locks first makes a later suspension wait, then both complete: the Founder has changed', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const id = (await propose(founder, g.id, next.accountId)).transfer.id;
      let reached!: () => void;
      let release!: () => void;
      const atHook = new Promise<void>((r) => (reached = r));
      const gate = new Promise<void>((r) => (release = r));
      // The host hook runs after the proposer check, with every lock held: the acceptance is held open here.
      const accepting = run((tx) =>
        respondOwnershipTransfer(
          tx,
          cmd(next, { guildId: g.id, transferId: id, decision: 'ACCEPT' }, 'acc-held'),
          {
            allowNewWrites: true,
            authorizeOwnershipTransfer: async () => {
              reached();
              await gate;
              return true;
            },
          },
        ),
      );
      accepting.catch(() => undefined);
      await atHook;
      let suspended = false;
      const suspending = suspend(founder).then(() => (suspended = true));
      await waitForLockWaiter('UPDATE "User"');
      expect(suspended).toBe(false);
      release();
      expect((await accepting).transfer).toMatchObject({ state: 'ACCEPTED', applied: true });
      await suspending;
      expect(await founderOf(g.id)).toBe(next.accountId);
      const [{ s }] = await db.$queryRawUnsafe<{ s: boolean }[]>(
        `SELECT "suspended" AS s FROM "User" WHERE "id"=$1`,
        founder.accountId,
      );
      expect(s).toBe(true);
    });

    it('never deadlocks with a Founder command: the proposer row is locked before the Guild row, as authorize() does', async () => {
      const { founder, guild: g } = await guild();
      const next = await person();
      const id = (await propose(founder, g.id, next.accountId)).transfer.id;
      let accepting: Promise<unknown> | undefined;
      let attempts = 0;
      // A Founder command has taken its own User row (FOR NO KEY UPDATE, authorize()) and reaches for the Guild row
      // next. The acceptance must therefore wait on that User row before it locks the Guild; if it locked the Guild
      // first, the two would wait on each other and PostgreSQL would abort one with 40P01.
      await db.$transaction(async (t) => {
        await t.$queryRawUnsafe(
          `SELECT "suspended" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE`,
          founder.accountId,
        );
        // A deadlock victim is retried by runCommandTransaction, which would hide it: count the attempts.
        accepting = run((tx) => {
          attempts++;
          return respondOwnershipTransfer(
            tx,
            cmd(next, { guildId: g.id, transferId: id, decision: 'ACCEPT' }, 'acc-deadlock'),
            ownerHost(),
          );
        });
        accepting.catch(() => undefined);
        await waitForLockWaiter(acceptWaiter);
        // Reaching the Guild row now must succeed (no 40P01 for either side).
        await t.$queryRawUnsafe(`SELECT 1 FROM "Guild" WHERE "id"=$1::uuid FOR UPDATE`, g.id);
      });
      expect((await accepting)!).toMatchObject({ status: 'EXECUTED' });
      expect(attempts).toBe(1);
      expect(await founderOf(g.id)).toBe(next.accountId);
    });

    it('a Founder command racing the acceptance completes with it, whichever order wins', async () => {
      for (const round of [1, 2, 3]) {
        const { founder, guild: g } = await guild('race-founder-' + round);
        const next = await person();
        const other = await person();
        const id = (await propose(founder, g.id, next.accountId)).transfer.id;
        const [accepted, granted] = await Promise.allSettled([
          respond(next, g.id, id, 'ACCEPT', 'acc-' + round),
          grant(
            founder,
            { guildId: g.id, granteeAccountId: other.accountId, kind: 'WORK' },
            'grant-' + round,
          ),
        ]);
        expect(accepted.status).toBe('fulfilled');
        // The grant ran under the old Founder or was refused as the former Founder; never an unmapped failure.
        if (granted.status === 'rejected')
          expect((granted.reason as { code?: string }).code).toBe('FORBIDDEN');
        expect(await founderOf(g.id)).toBe(next.accountId);
      }
    });
  });
});
