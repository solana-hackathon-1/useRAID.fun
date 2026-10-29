import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import {
  activateGuild,
  editGuildProfile,
  readManagedGuild,
  type GuildActor,
} from '../src/guild-profiles/guild-storage';
import { createGuildProfileHandlers } from '../src/guild-profiles/guild-profile-http';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
let counter = 0;
async function person(): Promise<GuildActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-profile-user-' + ++counter } });
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
/** A real-storage consumer of the transport: the host supplies the session actor and the write switch. */
let current: GuildActor;
let writes = true;
const handlers = createGuildProfileHandlers({
  version: 'v1',
  requestId: () => crypto.randomUUID(),
  actor: async () => current,
  checkOrigin: () => undefined,
  rateLimit: async () => undefined,
  read: async (actor, guildId) => {
    const { guild, authority } = await run((tx) => readManagedGuild(tx, actor, guildId));
    return {
      version: 'v1',
      guild,
      authority,
      writesAvailable: writes,
      unavailableReason: writes ? null : 'DISABLED',
    };
  },
  edit: (command) => run((tx) => editGuildProfile(tx, command, { allowNewWrites: writes })),
});
async function activeGuild() {
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
          profile: { name: 'Synthetic Guild', slug: 'synthetic-guild', description: 'Synthetic.' },
        },
        idempotencyKey: 'draft-key',
        requestId: 'draft-request',
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
          activationRef: 'evidence-record-1',
        },
        idempotencyKey: 'activate-key',
        requestId: 'activate-request',
      },
      { allowNewWrites: true, authorizeActivation: async () => true },
    ),
  );
  return { founder, guild: activated.guild };
}
const grantProfile = (guildId: string, grantee: GuildActor, fields: string[]) =>
  db.$executeRawUnsafe(
    `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","canDelegate","validFrom","grantedByAccountId")
     SELECT $1::uuid,$2,'PROFILE',$3::text[],false,clock_timestamp()-interval '1 minute',"founderAccountId" FROM "Guild" WHERE "id"=$1::uuid`,
    guildId,
    grantee.accountId,
    '{' + fields.join(',') + '}',
  );
const editRequest = (payload: unknown, key = 'edit-key') =>
  new Request('https://example.test/api/v1/guild-profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(payload),
  });
const readRequest = (guildId: string) =>
  new Request('https://example.test/api/v1/guild-profile?guildId=' + guildId);
const json = async (response: Response) => (await response.json()) as Record<string, any>;

integration('Guild profile edit over HTTP against real storage', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    writes = true;
  });
  afterAll(() => db.$disconnect());

  it('lets the Founder edit and replay, and shows the managed view with its authority', async () => {
    const { founder, guild } = await activeGuild();
    current = founder;
    const payload = {
      guildId: guild.id,
      expectedRevision: guild.revision,
      profile: { name: 'Renamed' },
    };
    const done = await handlers.EDIT(editRequest(payload));
    expect(done.status).toBe(200);
    expect(await json(done)).toMatchObject({
      status: 'EXECUTED',
      guild: { name: 'Renamed', revision: guild.revision + 1 },
    });
    const replay = await handlers.EDIT(editRequest(payload));
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({ status: 'REPLAYED', guild: { name: 'Renamed' } });
    const view = await json(await handlers.READ(readRequest(guild.id)));
    expect(view).toMatchObject({
      guild: { name: 'Renamed', revision: guild.revision + 1 },
      authority: { founder: true },
      writesAvailable: true,
    });
    const stale = await handlers.EDIT(editRequest(payload, 'edit-key-2'));
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.code).toBe('REVISION_CHANGED');
  });

  it('limits a grantee to the granted fields and tells a stranger nothing', async () => {
    const { guild } = await activeGuild();
    const grantee = await person();
    const stranger = await person();
    await grantProfile(guild.id, grantee, ['name']);
    current = grantee;
    const forbidden = await handlers.EDIT(
      editRequest(
        { guildId: guild.id, expectedRevision: guild.revision, profile: { description: 'Nope.' } },
        'grantee-description',
      ),
    );
    expect(forbidden.status).toBe(403);
    const allowed = await handlers.EDIT(
      editRequest(
        { guildId: guild.id, expectedRevision: guild.revision, profile: { name: 'By grantee' } },
        'grantee-name',
      ),
    );
    expect(allowed.status).toBe(200);
    current = stranger;
    for (const response of [
      await handlers.READ(readRequest(guild.id)),
      await handlers.EDIT(
        editRequest(
          { guildId: guild.id, expectedRevision: guild.revision + 1, profile: { name: 'Mine' } },
          'stranger-key',
        ),
      ),
    ]) {
      expect(response.status).toBe(403);
      expect(JSON.stringify(await json(response))).not.toContain('By grantee');
    }
    expect(
      await db.$queryRawUnsafe(
        'SELECT v."name" FROM "Guild" g JOIN "GuildProfileVersion" v ON v."id"=g."currentVersionId"',
      ),
    ).toEqual([{ name: 'By grantee' }]);
  });

  it('refuses new edits while the switch is off but keeps replays and reads', async () => {
    const { founder, guild } = await activeGuild();
    current = founder;
    const payload = {
      guildId: guild.id,
      expectedRevision: guild.revision,
      profile: { name: 'Renamed' },
    };
    expect((await handlers.EDIT(editRequest(payload))).status).toBe(200);
    writes = false;
    const blocked = await handlers.EDIT(
      editRequest({ ...payload, expectedRevision: guild.revision + 1 }, 'edit-key-new'),
    );
    expect(blocked.status).toBe(503);
    expect((await json(blocked)).error.code).toBe('NOT_AVAILABLE');
    expect((await handlers.EDIT(editRequest(payload))).status).toBe(200);
    expect(await json(await handlers.READ(readRequest(guild.id)))).toMatchObject({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  });
});
