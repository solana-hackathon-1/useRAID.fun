import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import {
  activateGuild,
  draftGuildUpdate,
  editGuildProfile,
  listManagedGuildUpdates,
  listPublicGuildUpdates,
  publishGuildUpdate,
  withdrawGuildUpdate,
  GUILD_DRAFT_UPDATE_LIMIT,
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
const grant = (
  guildId: string,
  grantee: GuildActor,
  patch: {
    kind?: string;
    fields?: string[];
    validFrom?: string;
    expiresAt?: string | null;
    revoked?: boolean;
  } = {},
) =>
  db.$executeRawUnsafe(
    `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","canDelegate","validFrom","expiresAt","revokedAt","grantedByAccountId")
     SELECT $1::uuid,$2,$3,$4::text[],false,COALESCE($5::timestamptz,clock_timestamp()-interval '1 minute'),$6::timestamptz,CASE WHEN $7::boolean THEN clock_timestamp() END,"founderAccountId" FROM "Guild" WHERE "id"=$1::uuid`,
    guildId,
    grantee.accountId,
    patch.kind ?? 'PROFILE',
    '{' + (patch.fields ?? ['name', 'description']).join(',') + '}',
    patch.validFrom ?? null,
    patch.expiresAt ?? null,
    patch.revoked ?? false,
  );

const grantRow = (guildId: string, grantee: GuildActor, kind = 'PROFILE') =>
  db.$executeRawUnsafe(
    `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","grantedByAccountId") SELECT $1::uuid,$2,$3,CASE WHEN $3='PROFILE' THEN ARRAY['name'] ELSE ARRAY[]::text[] END,"founderAccountId" FROM "Guild" WHERE "id"=$1::uuid`,
    guildId,
    grantee.accountId,
    kind,
  );
const draft = (
  actor: GuildActor,
  guildId: string,
  title = 'Milestone reached',
  body = 'We shipped the first release.',
  key?: string,
  writes = true,
) => run((tx) => draftGuildUpdate(tx, cmd(actor, { guildId, title, body }, key), host(writes)));
const publish = (
  actor: GuildActor,
  guildId: string,
  updateId: string,
  key?: string,
  writes = true,
) => run((tx) => publishGuildUpdate(tx, cmd(actor, { guildId, updateId }, key), host(writes)));
const withdraw = (
  actor: GuildActor,
  guildId: string,
  updateId: string,
  key?: string,
  writes = true,
) => run((tx) => withdrawGuildUpdate(tx, cmd(actor, { guildId, updateId }, key), host(writes)));
integration('T009 Guild public updates', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    operators.clear();
  });
  afterAll(() => db.$disconnect());

  it('lets a profile delegate draft and only the Founder publish; drafts are never public', async () => {
    const { founder, guild: g } = await guild('news-one');
    const delegate = await person();
    await grantRow(g.id, delegate);
    const d = await draft(delegate, g.id, 'First news', 'Hello <b>world</b> & friends', 'k-1');
    expect(d).toMatchObject({
      status: 'EXECUTED',
      update: {
        guildId: g.id,
        title: 'First news',
        state: 'DRAFT',
        authorAccountId: delegate.accountId,
        publishedAt: null,
      },
    });
    expect(
      (await draft(delegate, g.id, 'First news', 'Hello <b>world</b> & friends', 'k-1')).update.id,
    ).toBe(d.update.id);
    expect((await run((tx) => listPublicGuildUpdates(tx, 'news-one', {}))).updates).toEqual([]);
    await expect(publish(delegate, g.id, d.update.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const published = await publish(founder, g.id, d.update.id, 'pub-1');
    expect(published.update).toMatchObject({ state: 'PUBLISHED' });
    expect(published.update.publishedAt).not.toBeNull();
    const view = await run((tx) => listPublicGuildUpdates(tx, 'news-one', {}));
    // Exactly the public allowlist; text is returned as text, never interpreted or trimmed of markup.
    expect(view.updates).toEqual([
      {
        id: d.update.id,
        title: 'First news',
        body: 'Hello <b>world</b> & friends',
        publishedAt: published.update.publishedAt,
      },
    ]);
    const json = JSON.stringify(view);
    for (const secret of [delegate.accountId, founder.accountId, g.id, 'DRAFT', 'authorAccountId'])
      expect(json).not.toContain(secret);
    await expect(publish(founder, g.id, d.update.id, 'pub-2')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    const [{ audits }] = await db.$queryRawUnsafe<{ audits: number }[]>(
      `SELECT count(*)::int AS audits FROM "AuditEvent" WHERE "guildId"=$1 AND "eventType" LIKE 'guild.update_%'`,
      g.id,
    );
    expect(audits).toBe(2);
  });

  it('refuses drafting by strangers and by non-profile grantees, and in other Guilds', async () => {
    const a = await guild('news-a');
    const b = await guild('news-b');
    const stranger = await person();
    const worker = await person();
    const treasurer = await person();
    await grantRow(a.guild.id, worker, 'WORK');
    await grantRow(a.guild.id, treasurer, 'TREASURY');
    for (const who of [stranger, worker, treasurer, b.founder])
      await expect(draft(who, a.guild.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(draft(a.founder, a.guild.id, 'x', 'y', 'w', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    for (const bad of [
      { title: '' },
      { title: '   ' },
      { title: 't'.repeat(201) },
      { body: '' },
      { body: 'b'.repeat(4001) },
      { extra: 1 },
    ])
      await expect(
        run((tx) =>
          draftGuildUpdate(
            tx,
            cmd(a.founder, { guildId: a.guild.id, title: 'T', body: 'B', ...bad }),
            host(),
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const mine = await draft(a.founder, a.guild.id);
    await expect(publish(b.founder, a.guild.id, mine.update.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(publish(b.founder, b.guild.id, mine.update.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('withdraws: the Founder any update, an author only their own draft; a withdrawn update leaves the public view', async () => {
    const { founder, guild: g } = await guild('news-w');
    const author = await person();
    await grantRow(g.id, author);
    const pub = (await draft(founder, g.id, 'Public', 'Body')).update.id;
    await publish(founder, g.id, pub);
    const mine = (await draft(author, g.id, 'Mine', 'Body')).update.id;
    const stranger = await person();
    await expect(withdraw(author, g.id, pub)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(withdraw(stranger, g.id, mine)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await withdraw(author, g.id, mine)).update.state).toBe('WITHDRAWN');
    expect((await withdraw(founder, g.id, pub)).update.state).toBe('WITHDRAWN');
    expect((await run((tx) => listPublicGuildUpdates(tx, 'news-w', {}))).updates).toEqual([]);
    await expect(withdraw(founder, g.id, pub, 'again')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(publish(founder, g.id, mine, 'late')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
  });

  it('pages the public list newest first and shows managers only their own view', async () => {
    const { founder, guild: g } = await guild('news-p');
    const author = await person();
    await grantRow(g.id, author);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const id = (await draft(founder, g.id, `Update ${i}`, 'Body', `d-${i}`)).update.id;
      await publish(founder, g.id, id, `p-${i}`);
      ids.push(id);
    }
    const first = await run((tx) => listPublicGuildUpdates(tx, 'news-p', { limit: 2 }));
    expect(first.updates.map((u) => u.title)).toEqual(['Update 3', 'Update 2']);
    expect(first.nextCursor).toBe(ids[1]);
    const second = await run((tx) =>
      listPublicGuildUpdates(tx, 'news-p', { limit: 2, before: first.nextCursor! }),
    );
    expect(second.updates.map((u) => u.title)).toEqual(['Update 1']);
    expect(second.nextCursor).toBeNull();
    await expect(
      run((tx) => listPublicGuildUpdates(tx, 'news-p', { limit: 99 })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(run((tx) => listPublicGuildUpdates(tx, 'nope-nope', {}))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const own = (await draft(author, g.id, 'Author draft', 'Body')).update.id;
    expect(
      (await run((tx) => listManagedGuildUpdates(tx, founder, g.id))).updates.map((u) => u.title),
    ).toEqual(['Author draft', 'Update 3', 'Update 2', 'Update 1']);
    expect(
      (await run((tx) => listManagedGuildUpdates(tx, author, g.id))).updates.map((u) => u.id),
    ).toEqual([own]);
    const outsider = await person();
    await expect(run((tx) => listManagedGuildUpdates(tx, outsider, g.id))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('caps open drafts per Guild and replays only to someone who still may act', async () => {
    const { founder, guild: g } = await guild('news-c');
    const author = await person();
    await grantRow(g.id, author);
    const first = await draft(author, g.id, 'T', 'B', 'same');
    // The author lost profile authority: the same key no longer returns their draft.
    await db.$executeRawUnsafe(
      `UPDATE "GuildRoleGrant" SET "revokedAt"=clock_timestamp() WHERE "granteeAccountId"=$1`,
      author.accountId,
    );
    await expect(draft(author, g.id, 'T', 'B', 'same')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(first.update.state).toBe('DRAFT');
    for (let i = 1; i < GUILD_DRAFT_UPDATE_LIMIT; i++)
      await draft(founder, g.id, `Draft ${i}`, 'Body', `cap-${i}`);
    await expect(draft(founder, g.id, 'One too many', 'Body', 'cap-over')).rejects.toMatchObject({
      code: 'UPDATE_LIMIT',
    });
    // Publishing or withdrawing a draft frees room.
    const rows = (await db.$queryRawUnsafe(
      `SELECT "id"::text FROM "GuildUpdate" WHERE "guildId"=$1::uuid LIMIT 1`,
      g.id,
    )) as { id: string }[];
    await withdraw(founder, g.id, rows[0].id, 'free');
    expect((await draft(founder, g.id, 'Now fits', 'Body', 'cap-fits')).status).toBe('EXECUTED');
  });

  it('rejects direct writers that rewrite, delete or forge a publication', async () => {
    const { founder, guild: g } = await guild('news-d');
    const delegate = await person();
    await grantRow(g.id, delegate);
    const id = (await draft(delegate, g.id)).update.id;
    const attempt = (sql: string) =>
      db.$executeRawUnsafe(sql).then(
        () => 'accepted',
        (e: Error) => (/Guild/.test(e.message) ? 'guarded' : 'other:' + e.message),
      );
    expect(await attempt(`UPDATE "GuildUpdate" SET "body"='rewritten' WHERE "id"='${id}'`)).toBe(
      'guarded',
    );
    expect(await attempt(`DELETE FROM "GuildUpdate" WHERE "id"='${id}'`)).toBe('guarded');
    // Published by someone who is not the Founder.
    expect(
      await attempt(
        `UPDATE "GuildUpdate" SET "state"='PUBLISHED',"publishedAt"=clock_timestamp(),"publishedByAccountId"='${delegate.accountId}',"publishReceiptId"="draftReceiptId" WHERE "id"='${id}'`,
      ),
    ).toBe('guarded');
    // Published by the Founder but without that Founder's own publish receipt: refused at commit.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "GuildUpdate" SET "state"='PUBLISHED',"publishedAt"=clock_timestamp(),"publishedByAccountId"='${founder.accountId}',"publishReceiptId"="draftReceiptId" WHERE "id"='${id}'`,
      ),
    ).rejects.toThrow(/Guild/);
    expect((await run((tx) => listPublicGuildUpdates(tx, 'news-d', {}))).updates).toEqual([]);
  });
});
