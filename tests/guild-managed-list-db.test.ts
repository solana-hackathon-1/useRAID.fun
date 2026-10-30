import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import {
  activateGuild,
  listManagedGuilds,
  ManagedGuildListSchema,
  type GuildActor,
} from '../src/guild-profiles/guild-storage';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
let counter = 0;
async function person(): Promise<GuildActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-list-user-' + ++counter } });
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
let keyCounter = 0;
async function guild(slug: string, founder?: GuildActor) {
  const owner = founder ?? (await person());
  const operator = await person();
  operators.add(operator.accountId);
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
          profile: { name: 'Synthetic ' + slug, slug, description: 'About ' + slug },
        },
        idempotencyKey: 'draft-' + slug,
        requestId: 'request-draft-' + slug,
      },
      { allowNewWrites: true },
    ),
  );
  const key = 'activate-' + ++keyCounter;
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
        idempotencyKey: key,
        requestId: 'request-' + key,
      },
      {
        allowNewWrites: true,
        authorizeActivation: async (_tx: unknown, who: { accountId: string }) =>
          operators.has(who.accountId),
      },
    ),
  );
  return { founder: owner, guild: activated.guild };
}
const grant = (
  guildId: string,
  grantee: GuildActor,
  patch: { kind?: string; expiresAt?: string | null; revoked?: boolean } = {},
) =>
  db.$executeRawUnsafe(
    `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","canDelegate","validFrom","expiresAt","revokedAt","grantedByAccountId")
     SELECT $1::uuid,$2,$3,CASE WHEN $3='PROFILE' THEN ARRAY['name'] ELSE ARRAY[]::text[] END,false,clock_timestamp()-interval '1 minute',$4::timestamptz,CASE WHEN $5::boolean THEN clock_timestamp() END,"founderAccountId" FROM "Guild" WHERE "id"=$1::uuid`,
    guildId,
    grantee.accountId,
    patch.kind ?? 'PROFILE',
    patch.expiresAt ?? null,
    patch.revoked ?? false,
  );
const list = (actor: GuildActor) => run((tx) => listManagedGuilds(tx, actor));
integration('T009 own managed Guild list', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    operators.clear();
  });
  afterAll(() => db.$disconnect());

  it('lists exactly the Guilds the caller holds live authority in, with only the kinds held', async () => {
    const mine = await guild('my-guild');
    const other = await guild('other-guild');
    const { guilds } = await list(mine.founder);
    expect(guilds).toHaveLength(1);
    expect(guilds[0].guild).toMatchObject({
      id: mine.guild.id,
      slug: 'my-guild',
      revision: 1,
      founderAccountId: mine.founder.accountId,
    });
    expect(guilds[0].authority).toEqual({ founder: true, kinds: ['PROFILE', 'WORK'] });
    expect(JSON.stringify(guilds)).not.toContain(other.guild.id);
    expect(ManagedGuildListSchema.safeParse({ guilds }).success).toBe(true);
  });

  it('shows a stranger nothing, without any existence signal', async () => {
    await guild('hidden-guild');
    const stranger = await person();
    expect(await list(stranger)).toEqual({ guilds: [] });
  });

  it('redacts the Founder id for non-profile authority and keeps it for PROFILE managers', async () => {
    const g = await guild('shared-guild');
    const work = await person(),
      profile = await person(),
      treasury = await person();
    await grant(g.guild.id, work, { kind: 'WORK' });
    await grant(g.guild.id, profile, { kind: 'PROFILE' });
    await grant(g.guild.id, treasury, { kind: 'TREASURY' });
    const asWork = (await list(work)).guilds[0];
    expect(asWork.guild.founderAccountId).toBeNull();
    expect(asWork.authority).toEqual({ founder: false, kinds: ['WORK'] });
    expect(JSON.stringify(asWork)).not.toContain(g.founder.accountId);
    const asTreasury = (await list(treasury)).guilds[0];
    expect(asTreasury.guild.founderAccountId).toBeNull();
    expect(asTreasury.authority.kinds).toEqual(['TREASURY']);
    const asProfile = (await list(profile)).guilds[0];
    expect(asProfile.guild.founderAccountId).toBe(g.founder.accountId);
    expect(asProfile.authority).toEqual({ founder: false, kinds: ['PROFILE'] });
  });

  it('drops a Guild once its only grant is revoked or expired, and never counts a future one', async () => {
    const g = await guild('fading-guild');
    const revoked = await person(),
      expired = await person(),
      future = await person();
    await grant(g.guild.id, revoked, { revoked: true });
    await grant(g.guild.id, expired, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await db.$executeRawUnsafe(
      `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","canDelegate","validFrom","grantedByAccountId")
       SELECT $1::uuid,$2,'PROFILE',ARRAY['name'],false,clock_timestamp()+interval '1 day',"founderAccountId" FROM "Guild" WHERE "id"=$1::uuid`,
      g.guild.id,
      future.accountId,
    );
    for (const who of [revoked, expired, future]) expect(await list(who)).toEqual({ guilds: [] });
  });

  it('orders by slug, and lists a Founder who also holds a grant in another Guild once each', async () => {
    const a = await guild('bravo-guild');
    const b = await guild('alpha-guild');
    await grant(b.guild.id, a.founder, { kind: 'DISPUTE' });
    const { guilds } = await list(a.founder);
    expect(guilds.map((g) => g.guild.slug)).toEqual(['alpha-guild', 'bravo-guild']);
    expect(guilds[0].authority).toEqual({ founder: false, kinds: ['DISPUTE'] });
    expect(guilds[0].guild.founderAccountId).toBeNull();
    expect(guilds[1].authority.founder).toBe(true);
  });

  it('refuses an unauthenticated session, a foreign session and a suspended account', async () => {
    const g = await guild('gate-guild');
    await expect(list({ ...g.founder, sessionHash: 'f'.repeat(64) })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const stranger = await person();
    await expect(
      list({ accountId: g.founder.accountId, sessionHash: stranger.sessionHash }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(list({ accountId: '', sessionHash: g.founder.sessionHash })).rejects.toMatchObject(
      { code: 'INVALID_INPUT' },
    );
    await db.user.update({ where: { id: g.founder.accountId }, data: { suspended: true } });
    await expect(list(g.founder)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
  });
});
