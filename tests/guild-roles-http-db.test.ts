import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { createGuildRolesHandlers } from '../src/guild-profiles/guild-roles-http';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
let counter = 0;
async function person(): Promise<GuildActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-roles-user-' + ++counter } });
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
/** Real storage behind the transport; the switch and the ownership policy are the host's, like the Root host. */
let writes = true;
let approve = true;
const handlersFor = (actor: GuildActor) =>
  createGuildRolesHandlers({
    version: 'v1',
    requestId: () => crypto.randomUUID(),
    actor: async () => actor,
    checkOrigin: () => undefined,
    rateLimit: async () => undefined,
    grant: (command) => run((tx) => grantGuildRole(tx, command, { allowNewWrites: writes })),
    revoke: (command) => run((tx) => revokeGuildRole(tx, command, { allowNewWrites: writes })),
    propose: (command) =>
      run((tx) => proposeOwnershipTransfer(tx, command, { allowNewWrites: writes })),
    respond: (command) =>
      run((tx) =>
        respondOwnershipTransfer(tx, command, {
          allowNewWrites: writes,
          authorizeOwnershipTransfer: async () => approve,
        }),
      ),
  });
async function activeGuild(slug = 'synthetic-guild') {
  const founder = await person();
  const operator = await person();
  const saved = await run((tx) =>
    saveGuildDraft(
      tx,
      {
        actor: { ...founder, actorAccountId: founder.accountId },
        input: {
          guildDraftId: null,
          expectedRevision: 0,
          profile: { name: 'Synthetic ' + slug, slug, description: 'Synthetic.' },
        },
        idempotencyKey: 'draft-key-' + slug,
        requestId: 'draft-request-' + slug,
      },
      { allowNewWrites: true },
    ),
  );
  const activated = await run((tx) =>
    activateGuild(
      tx,
      {
        actor: operator,
        input: {
          guildDraftId: saved.draft.id,
          expectedDraftRevision: saved.draft.revision,
          activationRef: 'evidence-record-' + slug,
        },
        idempotencyKey: 'activate-key-' + slug,
        requestId: 'activate-request-' + slug,
      },
      { allowNewWrites: true, authorizeActivation: async () => true },
    ),
  );
  return { founder, guild: activated.guild };
}
const send = (path: string, payload: unknown, key = 'key-' + crypto.randomUUID()) =>
  new Request('https://example.test' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(payload),
  });
const grantReq = (payload: unknown, key?: string) => send('/api/v1/guild-grants', payload, key);
const revokeReq = (grantId: string, payload: unknown, key?: string) =>
  send(`/api/v1/guild-grants/${grantId}/revoke`, payload, key);
const proposeReq = (payload: unknown, key?: string) =>
  send('/api/v1/guild-ownership-transfers', payload, key);
const respondReq = (transferId: string, payload: unknown, key?: string) =>
  send(`/api/v1/guild-ownership-transfers/${transferId}`, payload, key);
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const soon = () => new Date(Date.now() + 86400000).toISOString();
const founderOf = async (guildId: string) =>
  (
    (await db.$queryRawUnsafe(
      'SELECT "founderAccountId" FROM "Guild" WHERE "id"=$1::uuid',
      guildId,
    )) as {
      founderAccountId: string;
    }[]
  )[0].founderAccountId;
const liveGrants = async (guildId: string) =>
  (await db.$queryRawUnsafe(
    `SELECT "id"::text,"granteeAccountId","grantedByAccountId","kind" FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid AND "revokedAt" IS NULL ORDER BY "validFrom","id"`,
    guildId,
  )) as { id: string; granteeAccountId: string; grantedByAccountId: string; kind: string }[];
const profileGrant = (
  guildId: string,
  grantee: GuildActor,
  extra: Record<string, unknown> = {},
) => ({
  guildId,
  granteeAccountId: grantee.accountId,
  kind: 'PROFILE',
  fields: ['name'],
  ...extra,
});

integration('Guild role and ownership management over HTTP against real storage', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    writes = true;
    approve = true;
  });
  afterAll(() => db.$disconnect());

  it('lets the Founder grant, replay and revoke, and shows the issuer only to those who may know it', async () => {
    const { founder, guild } = await activeGuild();
    const treasurer = await person();
    const asFounder = handlersFor(founder);
    const payload = { guildId: guild.id, granteeAccountId: treasurer.accountId, kind: 'TREASURY' };
    const done = await asFounder.GRANT(grantReq(payload, 'grant-1'));
    expect(done.status).toBe(200);
    const granted = await json(done);
    expect(granted).toMatchObject({
      status: 'EXECUTED',
      grant: { kind: 'TREASURY', granteeAccountId: treasurer.accountId, revokedAt: null },
    });
    expect(granted.grant.grantedByAccountId).toBe(founder.accountId);
    const replay = await json(await asFounder.GRANT(grantReq(payload, 'grant-1')));
    expect(replay).toMatchObject({ status: 'REPLAYED', grant: { id: granted.grant.id } });
    // The grantee surrenders it: a non-profile grantee never learns who issued it.
    const surrender = await handlersFor(treasurer).REVOKE(
      revokeReq(granted.grant.id, { guildId: guild.id }, 'revoke-1'),
      granted.grant.id,
    );
    expect(surrender.status).toBe(200);
    const surrendered = await json(surrender);
    expect(surrendered.grant.revokedAt).not.toBeNull();
    expect(surrendered.grant.grantedByAccountId).toBeNull();
    expect(JSON.stringify(surrendered)).not.toContain(founder.accountId);
    // The same key still succeeds after the state moved on; a fresh key says the record changed.
    const again = await handlersFor(treasurer).REVOKE(
      revokeReq(granted.grant.id, { guildId: guild.id }, 'revoke-1'),
      granted.grant.id,
    );
    expect(again.status).toBe(200);
    expect((await json(again)).status).toBe('REPLAYED');
    const repeat = await asFounder.REVOKE(
      revokeReq(granted.grant.id, { guildId: guild.id }, 'revoke-2'),
      granted.grant.id,
    );
    expect(repeat.status).toBe(409);
    expect((await json(repeat)).error.code).toBe('REVISION_CHANGED');
    // The issuer replays its own grant even after revocation.
    expect((await asFounder.GRANT(grantReq(payload, 'grant-1'))).status).toBe(200);
  });

  it('denies a stranger, a holder and a wrong-Guild caller without revealing what exists', async () => {
    const { founder, guild } = await activeGuild('guild-a');
    const other = await activeGuild('guild-b');
    const grantee = await person();
    const stranger = await person();
    const made = await json(
      await handlersFor(founder).GRANT(grantReq(profileGrant(guild.id, grantee), 'g-1')),
    );
    const grantId = made.grant.id as string;
    const before = await liveGrants(guild.id);
    // A stranger, and the Founder of ANOTHER Guild, can neither grant nor revoke here.
    for (const actor of [stranger, other.founder]) {
      const as = handlersFor(actor);
      const grant = await as.GRANT(
        grantReq(profileGrant(guild.id, stranger, { fields: ['name'] })),
      );
      expect(grant.status).toBe(403);
      const revoke = await as.REVOKE(revokeReq(grantId, { guildId: guild.id }), grantId);
      expect(revoke.status).toBe(403);
      // Guessing a Guild id and a grant id that do not belong together reveals nothing either.
      const missing = await as.REVOKE(
        revokeReq(grantId, { guildId: '99999999-9999-4999-8999-999999999999' }),
        grantId,
      );
      expect(missing.status).toBe(403);
      expect(JSON.stringify(await json(missing))).not.toContain(guild.id);
    }
    // The other Founder cannot reach this grant through their own Guild id either (cross-Guild IDOR): it is simply not
    // a grant of their Guild, and it stays live.
    const idor = await handlersFor(other.founder).REVOKE(
      revokeReq(grantId, { guildId: other.guild.id }),
      grantId,
    );
    expect(idor.status).toBe(404);
    // A mere profile grantee without delegation rights cannot pass anything on.
    const noDelegation = await handlersFor(grantee).GRANT(
      grantReq(profileGrant(guild.id, stranger, { fields: ['name'] })),
    );
    expect(noDelegation.status).toBe(403);
    expect(await liveGrants(guild.id)).toEqual(before);
  });

  it('keeps delegation inside what the delegate holds, and a revoked delegate loses it with everything passed on', async () => {
    const { founder, guild } = await activeGuild();
    const delegate = await person();
    const helper = await person();
    const asFounder = handlersFor(founder);
    const root = await json(
      await asFounder.GRANT(
        grantReq(
          profileGrant(delegate.accountId ? guild.id : guild.id, delegate, {
            fields: ['name'],
            canDelegate: true,
          }),
        ),
      ),
    );
    const asDelegate = handlersFor(delegate);
    // Beyond the delegate's own field, kind or delegation right: all forbidden.
    for (const wider of [
      profileGrant(guild.id, helper, { fields: ['description'] }),
      profileGrant(guild.id, helper, { fields: ['name'], canDelegate: true }),
      { guildId: guild.id, granteeAccountId: helper.accountId, kind: 'TREASURY' },
    ])
      expect((await asDelegate.GRANT(grantReq(wider))).status).toBe(403);
    const passed = await json(
      await asDelegate.GRANT(grantReq(profileGrant(guild.id, helper, { fields: ['name'] }))),
    );
    expect(passed.grant.grantedByAccountId).toBe(delegate.accountId);
    expect((await liveGrants(guild.id)).map((g) => g.granteeAccountId).sort()).toEqual(
      [delegate.accountId, helper.accountId].sort(),
    );
    // Revoking the delegating grant takes what was passed on with it.
    expect(
      (await asFounder.REVOKE(revokeReq(root.grant.id, { guildId: guild.id }), root.grant.id))
        .status,
    ).toBe(200);
    expect(await liveGrants(guild.id)).toEqual([]);
    expect(
      (await asDelegate.GRANT(grantReq(profileGrant(guild.id, helper, { fields: ['name'] }))))
        .status,
    ).toBe(403);
  });

  it('refuses new grants and proposals while the switch is off, but never blocks revocation', async () => {
    const { founder, guild } = await activeGuild();
    const grantee = await person();
    const heir = await person();
    const asFounder = handlersFor(founder);
    const made = await json(await asFounder.GRANT(grantReq(profileGrant(guild.id, grantee))));
    writes = false;
    for (const response of [
      await asFounder.GRANT(grantReq(profileGrant(guild.id, heir))),
      await asFounder.PROPOSE(
        proposeReq({ guildId: guild.id, toAccountId: heir.accountId, expiresAt: soon() }),
      ),
    ]) {
      expect(response.status).toBe(503);
      expect((await json(response)).error.code).toBe('NOT_AVAILABLE');
    }
    const revoked = await asFounder.REVOKE(
      revokeReq(made.grant.id, { guildId: guild.id }),
      made.grant.id,
    );
    expect(revoked.status).toBe(200);
    expect(await liveGrants(guild.id)).toEqual([]);
  });

  it('moves the Founder only through a proposal, the recipient’s own acceptance and the host’s approval', async () => {
    const { founder, guild } = await activeGuild();
    const heir = await person();
    const stranger = await person();
    const body = { guildId: guild.id, toAccountId: heir.accountId, expiresAt: soon() };
    // Only the Founder proposes.
    expect((await handlersFor(stranger).PROPOSE(proposeReq(body))).status).toBe(403);
    expect((await handlersFor(heir).PROPOSE(proposeReq(body))).status).toBe(403);
    const proposed = await json(await handlersFor(founder).PROPOSE(proposeReq(body, 'propose-1')));
    expect(proposed.transfer).toMatchObject({ state: 'PROPOSED', applied: false });
    const transferId = proposed.transfer.id as string;
    expect(
      (await json(await handlersFor(founder).PROPOSE(proposeReq(body, 'propose-1')))).status,
    ).toBe('REPLAYED');
    // One open proposal per Guild.
    const second = await handlersFor(founder).PROPOSE(proposeReq(body, 'propose-2'));
    expect(second.status).toBe(409);
    expect((await json(second)).error.code).toBe('GUILD_TRANSFER_PENDING');
    // The proposer cannot accept for the recipient; a stranger cannot respond at all.
    for (const actor of [founder, stranger])
      expect(
        (
          await handlersFor(actor).RESPOND(
            respondReq(transferId, { guildId: guild.id, decision: 'ACCEPT' }),
            transferId,
          )
        ).status,
      ).toBe(403);
    // The host's closed policy keeps the Founder where it is.
    approve = false;
    const refused = await handlersFor(heir).RESPOND(
      respondReq(transferId, { guildId: guild.id, decision: 'ACCEPT' }),
      transferId,
    );
    expect(refused.status).toBe(403);
    expect(await founderOf(guild.id)).toBe(founder.accountId);
    approve = true;
    const accepted = await json(
      await handlersFor(heir).RESPOND(
        respondReq(transferId, { guildId: guild.id, decision: 'ACCEPT' }, 'accept-1'),
        transferId,
      ),
    );
    expect(accepted).toMatchObject({
      status: 'EXECUTED',
      transfer: { state: 'ACCEPTED', applied: true },
    });
    expect(await founderOf(guild.id)).toBe(heir.accountId);
    // The same key replays after the world moved on; a new decision on the decided proposal is a conflict.
    const replay = await handlersFor(heir).RESPOND(
      respondReq(transferId, { guildId: guild.id, decision: 'ACCEPT' }, 'accept-1'),
      transferId,
    );
    expect((await json(replay)).status).toBe('REPLAYED');
    const late = await handlersFor(heir).RESPOND(
      respondReq(transferId, { guildId: guild.id, decision: 'DECLINE' }, 'decline-late'),
      transferId,
    );
    expect(late.status).toBe(409);
    expect((await json(late)).error.code).toBe('REVISION_CHANGED');
    // The former Founder no longer proposes or edits grants as Founder.
    expect(
      (await handlersFor(founder).PROPOSE(proposeReq({ ...body, toAccountId: founder.accountId })))
        .status,
    ).toBe(403);
  });

  it('lets the recipient decline and only the proposing Founder withdraw; a transfer id from another Guild is not found', async () => {
    const a = await activeGuild('guild-a');
    const b = await activeGuild('guild-b');
    const heir = await person();
    const open = async (founder: GuildActor, guildId: string) =>
      (
        await json(
          await handlersFor(founder).PROPOSE(
            proposeReq({ guildId, toAccountId: heir.accountId, expiresAt: soon() }),
          ),
        )
      ).transfer.id as string;
    const idA = await open(a.founder, a.guild.id);
    const idB = await open(b.founder, b.guild.id);
    // Cross-Guild: B's Founder withdrawing A's transfer through A's or B's id.
    expect(
      (
        await handlersFor(b.founder).RESPOND(
          respondReq(idA, { guildId: a.guild.id, decision: 'WITHDRAW' }),
          idA,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlersFor(b.founder).RESPOND(
          respondReq(idA, { guildId: b.guild.id, decision: 'WITHDRAW' }),
          idA,
        )
      ).status,
    ).toBe(404);
    // The recipient cannot withdraw; the proposer cannot decline.
    expect(
      (
        await handlersFor(heir).RESPOND(
          respondReq(idA, { guildId: a.guild.id, decision: 'WITHDRAW' }),
          idA,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlersFor(a.founder).RESPOND(
          respondReq(idA, { guildId: a.guild.id, decision: 'DECLINE' }),
          idA,
        )
      ).status,
    ).toBe(403);
    const declined = await json(
      await handlersFor(heir).RESPOND(
        respondReq(idA, { guildId: a.guild.id, decision: 'DECLINE' }),
        idA,
      ),
    );
    expect(declined.transfer).toMatchObject({ state: 'DECLINED', applied: false });
    const withdrawn = await json(
      await handlersFor(b.founder).RESPOND(
        respondReq(idB, { guildId: b.guild.id, decision: 'WITHDRAW' }),
        idB,
      ),
    );
    expect(withdrawn.transfer).toMatchObject({ state: 'WITHDRAWN', applied: false });
    expect(await founderOf(a.guild.id)).toBe(a.founder.accountId);
    expect(await founderOf(b.guild.id)).toBe(b.founder.accountId);
  });

  it('races: concurrent revokes, accepts and withdraws leave exactly one outcome and one Founder', async () => {
    const { founder, guild } = await activeGuild();
    const heir = await person();
    const grantee = await person();
    const asFounder = handlersFor(founder);
    const made = await json(await asFounder.GRANT(grantReq(profileGrant(guild.id, grantee))));
    // Two revocations with different keys: one wins, the other sees the record already changed.
    const revokes = await Promise.all(
      [founder, grantee].map((who, i) =>
        handlersFor(who).REVOKE(
          revokeReq(made.grant.id, { guildId: guild.id }, 'race-revoke-' + i),
          made.grant.id,
        ),
      ),
    );
    expect(revokes.map((r) => r.status).sort()).toEqual([200, 409]);
    // Same key twice: both succeed, one executed and one replayed.
    const other = await json(await asFounder.GRANT(grantReq(profileGrant(guild.id, heir))));
    const same = await Promise.all(
      [0, 1].map(() =>
        asFounder.REVOKE(
          revokeReq(other.grant.id, { guildId: guild.id }, 'same-key'),
          other.grant.id,
        ),
      ),
    );
    expect(same.map((r) => r.status)).toEqual([200, 200]);
    expect((await Promise.all(same.map(json))).map((b) => b.status).sort()).toEqual([
      'EXECUTED',
      'REPLAYED',
    ]);
    // ACCEPT racing WITHDRAW (and a second ACCEPT): exactly one decision lands.
    const proposed = await json(
      await asFounder.PROPOSE(
        proposeReq({ guildId: guild.id, toAccountId: heir.accountId, expiresAt: soon() }),
      ),
    );
    const id = proposed.transfer.id as string;
    const decisions = await Promise.all([
      handlersFor(heir).RESPOND(
        respondReq(id, { guildId: guild.id, decision: 'ACCEPT' }, 'a1'),
        id,
      ),
      handlersFor(heir).RESPOND(
        respondReq(id, { guildId: guild.id, decision: 'ACCEPT' }, 'a2'),
        id,
      ),
      asFounder.RESPOND(respondReq(id, { guildId: guild.id, decision: 'WITHDRAW' }, 'w1'), id),
    ]);
    const statuses = decisions.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    // A loser is a conflict, or no longer the Founder who may withdraw once an acceptance landed first.
    for (const status of statuses.filter((s) => s !== 200)) expect([403, 409]).toContain(status);
    const winner = (await Promise.all(decisions.filter((r) => r.status === 200).map(json)))[0];
    expect(await founderOf(guild.id)).toBe(
      winner.transfer.state === 'ACCEPTED' ? heir.accountId : founder.accountId,
    );
    const rows = (await db.$queryRawUnsafe(
      `SELECT "state" FROM "GuildOwnershipTransfer" WHERE "id"=$1::uuid`,
      id,
    )) as { state: string }[];
    expect(rows).toEqual([{ state: winner.transfer.state }]);
  });

  it('races: a delegate granting while the Founder revokes the delegating grant never leaves a live orphan', async () => {
    for (let round = 0; round < 3; round++) {
      await truncateAll(db);
      const { founder, guild } = await activeGuild('race-' + round);
      const delegate = await person();
      const helper = await person();
      const root = await json(
        await handlersFor(founder).GRANT(
          grantReq(profileGrant(guild.id, delegate, { canDelegate: true })),
        ),
      );
      const [pass, revoke] = await Promise.all([
        handlersFor(delegate).GRANT(grantReq(profileGrant(guild.id, helper))),
        handlersFor(founder).REVOKE(revokeReq(root.grant.id, { guildId: guild.id }), root.grant.id),
      ]);
      expect(revoke.status).toBe(200);
      expect([200, 403]).toContain(pass.status);
      // Either order: nothing the revoked delegate passed on is still live.
      expect(await liveGrants(guild.id)).toEqual([]);
    }
  });

  it('never leaks internals: every failure is a fixed envelope', async () => {
    const { founder, guild } = await activeGuild();
    const stranger = await person();
    const responses = [
      await handlersFor(stranger).GRANT(grantReq(profileGrant(guild.id, stranger))),
      await handlersFor(founder).GRANT(
        grantReq({ ...profileGrant(guild.id, founder), fields: ['name'] }),
      ),
      await handlersFor(founder).GRANT(
        grantReq(profileGrant(guild.id, stranger, { expiresAt: '2020-01-01T00:00:00.000Z' })),
      ),
    ];
    for (const response of responses) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      const text = JSON.stringify(await json(response));
      for (const hidden of ['SELECT', 'GuildRoleGrant', 'prisma', 'GRANT_REVOKED', 'STORAGE_']) {
        expect(text).not.toContain(hidden);
      }
    }
  });
});
