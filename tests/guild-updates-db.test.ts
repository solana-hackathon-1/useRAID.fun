import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createGuildUpdatesHandlers } from '../src/guild-profiles/guild-updates-http';
import { createGuildPublicHandlers } from '../src/guild-profiles/guild-public-http';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import {
  activateGuild,
  draftGuildUpdate,
  editGuildProfile,
  listManagedGuildUpdates,
  readPublicGuild,
  listPublicGuildUpdates,
  proposeOwnershipTransfer,
  respondOwnershipTransfer,
  publishGuildUpdate,
  withdrawGuildUpdate,
  GUILD_DRAFT_UPDATE_LIMIT,
  GUILD_UNPUBLISHED_UPDATE_LIMIT,
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
/** Test-only: lifts the immutability guard for one statement to build fixtures the application cannot (ties, retention). */
async function withoutUpdateGuard(work: () => Promise<unknown>) {
  await db.$executeRawUnsafe(`ALTER TABLE "GuildUpdate" DISABLE TRIGGER guild_update_guard_v1`);
  try {
    await work();
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "GuildUpdate" ENABLE TRIGGER guild_update_guard_v1`);
  }
}
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

  it('review follow-up: a non-manager is refused before any lock and cannot tell a missing update from an existing one', async () => {
    const a = await guild('lock-a');
    const mine = await draft(a.founder, a.guild.id);
    const stranger = await person();
    const worker = await person();
    const grantee = await person();
    await grantRow(a.guild.id, worker, 'WORK');
    await grantRow(a.guild.id, grantee, 'PROFILE');
    // Hold the Guild row as a competing writer would; a refused account must not queue behind it.
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(async (t) => {
      await t.$queryRawUnsafe('SELECT 1 FROM "Guild" WHERE "id"=$1::uuid FOR UPDATE', a.guild.id);
      locked();
      await held;
    });
    await ready;
    const outcome = (work: Promise<unknown>) =>
      Promise.race([
        work.then(
          () => 'EXECUTED',
          (e: { code?: string }) => e.code ?? 'ERROR',
        ),
        new Promise<string>((r) => setTimeout(() => r('BLOCKED'), 4000)),
      ]);
    try {
      const unknownUpdate = crypto.randomUUID();
      const unknownGuild = crypto.randomUUID();
      for (const who of [stranger, worker])
        for (const id of [mine.update.id, unknownUpdate]) {
          expect(await outcome(publish(who, a.guild.id, id)), 'publish').toBe('FORBIDDEN');
          expect(await outcome(withdraw(who, a.guild.id, id)), 'withdraw').toBe('FORBIDDEN');
        }
      expect(await outcome(withdraw(stranger, unknownGuild, unknownUpdate))).toBe('FORBIDDEN');
      // Only the Founder publishes, so a delegate is turned away without waiting either.
      expect(await outcome(publish(grantee, a.guild.id, mine.update.id))).toBe('FORBIDDEN');
    } finally {
      release();
      await holder;
    }
    expect((await publish(a.founder, a.guild.id, mine.update.id)).update.state).toBe('PUBLISHED');
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

  it('review fix: an author whose profile authority ended cannot withdraw, even their own draft', async () => {
    const { guild: g } = await guild('news-wr');
    const author = await person();
    await grantRow(g.id, author);
    const mine = (await draft(author, g.id, 'Mine', 'Body')).update.id;
    await db.$executeRawUnsafe(
      `UPDATE "GuildRoleGrant" SET "revokedAt"=clock_timestamp() WHERE "granteeAccountId"=$1`,
      author.accountId,
    );
    await expect(withdraw(author, g.id, mine)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('review fix: a Founder can take a public update down while new writes are disabled', async () => {
    const { founder, guild: g } = await guild('news-kill');
    const id = (await draft(founder, g.id, 'Harmful', 'Body')).update.id;
    await publish(founder, g.id, id);
    await expect(draft(founder, g.id, 'x', 'y', 'k-d', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    const other = (await draft(founder, g.id, 'Later', 'Body')).update.id;
    await expect(publish(founder, g.id, other, 'k-p2', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    expect((await withdraw(founder, g.id, id, 'k-w', false)).update.state).toBe('WITHDRAWN');
    expect((await run((tx) => listPublicGuildUpdates(tx, 'news-kill', {}))).updates).toEqual([]);
  });

  it('review fix: drafting and withdrawing cannot churn without bound; withdrawn rows leave the managed view', async () => {
    const { founder, guild: g } = await guild('news-churn');
    const author = await person();
    await grantRow(g.id, author);
    for (let i = 0; i < GUILD_UNPUBLISHED_UPDATE_LIMIT; i++) {
      const id = (await draft(author, g.id, `Churn ${i}`, 'Body', `c-${i}`)).update.id;
      await withdraw(author, g.id, id, `w-${i}`);
    }
    await expect(draft(author, g.id, 'One more', 'Body', 'c-over')).rejects.toMatchObject({
      code: 'UPDATE_LIMIT',
    });
    // The cap is per author: the Founder is unaffected, and published updates never count.
    const live = (await draft(founder, g.id, 'Live', 'Body', 'f-1')).update.id;
    await publish(founder, g.id, live, 'f-p');
    expect(
      (await run((tx) => listManagedGuildUpdates(tx, founder, g.id))).updates.map((u) => u.title),
    ).toEqual(['Live']);
  }, 120_000);

  it('serves only the public projection over HTTP and drops a withdrawn update at once', async () => {
    const { founder, guild: g } = await guild('news-http');
    const first = (await draft(founder, g.id, 'First', 'Body one')).update.id;
    await publish(founder, g.id, first);
    const second = (await draft(founder, g.id, 'Second', 'Body two')).update.id;
    await publish(founder, g.id, second);
    await draft(founder, g.id, 'Unpublished', 'Not public');
    const handlers = createGuildPublicHandlers({
      version: 'v1',
      requestId: () => 'request-1',
      available: () => true,
      rateLimit: () => undefined,
      guild: (slug) => run((tx) => readPublicGuild(tx, slug)),
      updates: (slug, query) => run((tx) => listPublicGuildUpdates(tx, slug, query)),
    });
    const url = (path: string) => new Request('https://example.test/api/v1/guilds/' + path);
    const profile = await handlers.GUILD(url('news-http'), 'news-http');
    expect(profile.status).toBe(200);
    expect(Object.keys(await profile.json()).sort()).toEqual([
      'description',
      'id',
      'name',
      'primaryToken',
      'slug',
    ]);
    const listed = await handlers.UPDATES(url('news-http/updates'), 'news-http');
    const page = (await listed.json()) as { updates: Record<string, unknown>[] };
    expect(page.updates.map((u) => u.title)).toEqual(['Second', 'First']);
    for (const update of page.updates)
      expect(Object.keys(update).sort()).toEqual(['body', 'id', 'publishedAt', 'title']);
    await withdraw(founder, g.id, second);
    const after = (await (
      await handlers.UPDATES(url('news-http/updates'), 'news-http')
    ).json()) as {
      updates: { title: string }[];
    };
    expect(after.updates.map((u) => u.title)).toEqual(['First']);
    expect((await handlers.GUILD(url('nobody'), 'nobody')).status).toBe(404);
  });

  it('manages updates over HTTP with the session actor: draft, replay, publish, outsider denied, withdraw', async () => {
    const { founder, guild: g } = await guild('news-mgmt');
    const outsider = await person();
    let current: GuildActor = founder;
    const handlers = createGuildUpdatesHandlers({
      version: 'v1',
      requestId: () => 'request-1',
      actor: async () => current,
      checkOrigin: () => undefined,
      rateLimit: async () => undefined,
      list: async (actor, guildId) => ({
        version: 'v1',
        updates: (await run((tx) => listManagedGuildUpdates(tx, actor, guildId))).updates,
        writesAvailable: true,
        unavailableReason: null,
      }),
      draft: (command) => run((tx) => draftGuildUpdate(tx, command, host())),
      publish: (command) => run((tx) => publishGuildUpdate(tx, command, host())),
      withdraw: (command) => run((tx) => withdrawGuildUpdate(tx, command, host())),
    });
    const send = (path: string, payload: unknown, key: string) =>
      new Request('https://example.test' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(payload),
      });
    const drafted = await handlers.DRAFT(
      send('/api/v1/guild-updates', { guildId: g.id, title: 'Hello', body: 'World' }, 'h-1'),
    );
    expect(drafted.status).toBe(200);
    const created = (await drafted.json()) as { status: string; update: { id: string } };
    expect(created.status).toBe('EXECUTED');
    const replay = await handlers.DRAFT(
      send('/api/v1/guild-updates', { guildId: g.id, title: 'Hello', body: 'World' }, 'h-1'),
    );
    expect(((await replay.json()) as { status: string }).status).toBe('REPLAYED');
    const step = (action: string, key: string) =>
      handlers.STEP(
        send('/api/v1/guild-updates/' + created.update.id, { guildId: g.id, action }, key),
        created.update.id,
      );
    current = outsider;
    expect((await step('PUBLISH', 'h-2')).status).toBe(403);
    expect(
      (
        await handlers.LIST(
          new Request('https://example.test/api/v1/guild-updates?guildId=' + g.id),
        )
      ).status,
    ).toBe(403);
    current = founder;
    expect((await step('PUBLISH', 'h-3')).status).toBe(200);
    expect((await run((tx) => listPublicGuildUpdates(tx, 'news-mgmt', {}))).updates).toHaveLength(
      1,
    );
    expect((await step('PUBLISH', 'h-4')).status).toBe(409);
    expect((await step('WITHDRAW', 'h-5')).status).toBe(200);
    expect((await run((tx) => listPublicGuildUpdates(tx, 'news-mgmt', {}))).updates).toEqual([]);
    // Retries after the update has moved on still succeed as replays.
    const lateDraft = await handlers.DRAFT(
      send('/api/v1/guild-updates', { guildId: g.id, title: 'Hello', body: 'World' }, 'h-1'),
    );
    expect(lateDraft.status).toBe(200);
    expect(((await lateDraft.json()) as { status: string }).status).toBe('REPLAYED');
    const latePublish = await step('PUBLISH', 'h-3');
    expect(latePublish.status).toBe(200);
    expect(((await latePublish.json()) as { status: string }).status).toBe('REPLAYED');
    const managed = (await (
      await handlers.LIST(new Request('https://example.test/api/v1/guild-updates?guildId=' + g.id))
    ).json()) as { updates: unknown[] };
    expect(managed.updates).toEqual([]);
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

  it('review follow-up: a cursor that names no published update of this Guild is INVALID_INPUT, not the end of the feed', async () => {
    const { founder, guild: g } = await guild('news-c');
    const { founder: other, guild: h } = await guild('news-c-other');
    const ids: string[] = [];
    for (let i = 1; i <= 2; i++) {
      const id = (await draft(founder, g.id, `Update ${i}`, 'Body', `c-d-${i}`)).update.id;
      await publish(founder, g.id, id, `c-p-${i}`);
      ids.push(id);
    }
    const unpublished = (await draft(founder, g.id, 'Still a draft', 'Body')).update.id;
    const foreign = (await draft(other, h.id, 'Elsewhere', 'Body')).update.id;
    await publish(other, h.id, foreign);
    for (const before of [crypto.randomUUID(), unpublished, foreign])
      await expect(
        run((tx) => listPublicGuildUpdates(tx, 'news-c', { before })),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // A page cursor stays usable if that update is taken down after the page was served.
    await withdraw(founder, g.id, ids[1]);
    expect(
      (await run((tx) => listPublicGuildUpdates(tx, 'news-c', { before: ids[1] }))).updates.map(
        (u) => u.title,
      ),
    ).toEqual(['Update 1']);
  });

  it('review follow-up: the managed list reads its rows in a fixed number of queries', async () => {
    const { founder, guild: g } = await guild('news-q');
    for (let i = 1; i <= 5; i++) await draft(founder, g.id, `Draft ${i}`, 'Body', `q-${i}`);
    const counted = async (rows: number) => {
      let queries = 0;
      const result = await run((tx) =>
        listManagedGuildUpdates(
          {
            ...tx,
            query: ((...args: Parameters<typeof tx.query>) => {
              queries++;
              return tx.query(...args);
            }) as typeof tx.query,
          },
          founder,
          g.id,
        ),
      );
      expect(result.updates).toHaveLength(rows);
      return queries;
    };
    const five = await counted(5);
    await draft(founder, g.id, 'Draft 6', 'Body', 'q-6');
    expect(await counted(6)).toBe(five);
  });

  it('DEC-2026-11-14-04: the managed list pages by a keyset cursor, stable across equal timestamps', async () => {
    const { founder, guild: g } = await guild('news-mk');
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++)
      ids.push((await draft(founder, g.id, `Row ${i}`, 'Body', `mk-${i}`)).update.id);
    // Two groups of equal createdAt force the id tie-break to decide the order.
    await withoutUpdateGuard(() =>
      db.$executeRawUnsafe(
        `UPDATE "GuildUpdate" SET "createdAt"=CASE WHEN "id"=ANY($1::uuid[]) THEN '2026-01-01T00:00:00Z'::timestamptz ELSE '2026-01-02T00:00:00Z'::timestamptz END WHERE "guildId"=$2::uuid`,
        ids.slice(0, 3),
        g.id,
      ),
    );
    const expected = [...ids.slice(3).sort().reverse(), ...ids.slice(0, 3).sort().reverse()];
    const seen: string[] = [];
    let before: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await run((tx) =>
        listManagedGuildUpdates(tx, founder, g.id, { limit: 2, ...(before ? { before } : {}) }),
      );
      expect(page.updates.length).toBeLessThanOrEqual(2);
      seen.push(...page.updates.map((u) => u.id));
      if (page.nextCursor === null) break;
      expect(page.nextCursor).toBe(page.updates[page.updates.length - 1].id);
      before = page.nextCursor;
    }
    expect(seen).toEqual(expected);
    // The first page of a caller that ignores the cursor is unchanged (newest 100, no options needed).
    const whole = await run((tx) => listManagedGuildUpdates(tx, founder, g.id));
    expect(whole.updates.map((u) => u.id)).toEqual(expected);
    expect(whole.nextCursor).toBeNull();
    await expect(
      run((tx) => listManagedGuildUpdates(tx, founder, g.id, { limit: 101 })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('DEC-2026-11-14-04: more than 100 managed rows are each reachable once, in order', async () => {
    const { founder, guild: g } = await guild('news-m105');
    const ids: string[] = [];
    // Open drafts are capped per Guild; publishing frees room.
    for (let round = 0; round < 3; round++)
      for (let i = 0; i < 35; i++) {
        const id = (await draft(founder, g.id, `Bulk ${round}-${i}`, 'Body', `b-d-${round}-${i}`))
          .update.id;
        await publish(founder, g.id, id, `b-p-${round}-${i}`);
        ids.push(id);
      }
    const first = await run((tx) => listManagedGuildUpdates(tx, founder, g.id));
    expect(first.updates).toHaveLength(100);
    expect(first.nextCursor).toBe(first.updates[99].id);
    const second = await run((tx) =>
      listManagedGuildUpdates(tx, founder, g.id, { before: first.nextCursor! }),
    );
    expect(second.updates).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const all = [...first.updates, ...second.updates].map((u) => u.id);
    expect(new Set(all).size).toBe(105);
    expect([...all].sort()).toEqual([...ids].sort());
  }, 180_000);

  it('DEC-2026-11-14-04: a cursor the caller may not see is the same INVALID_INPUT as an unknown one', async () => {
    const { founder, guild: g } = await guild('news-mf');
    const { founder: other, guild: h } = await guild('news-mf-other');
    const delegate = await person();
    const rival = await person();
    await grantRow(g.id, delegate);
    await grantRow(g.id, rival);
    const own = (await draft(delegate, g.id, 'Mine', 'Body')).update.id;
    const theirs = (await draft(rival, g.id, 'Rival draft', 'Body')).update.id;
    const foreign = (await draft(other, h.id, 'Elsewhere', 'Body')).update.id;
    const refusals: { code?: string; message?: string }[] = [];
    for (const before of [crypto.randomUUID(), foreign, theirs])
      refusals.push(
        await run((tx) => listManagedGuildUpdates(tx, delegate, g.id, { before })).catch(
          (error) => error,
        ),
      );
    for (const refusal of refusals) expect(refusal).toMatchObject({ code: 'INVALID_INPUT' });
    // Indistinguishable: the same code and message whatever the row is.
    expect(new Set(refusals.map((e) => e.message)).size).toBe(1);
    // A malformed cursor fails the same way.
    await expect(
      run((tx) => listManagedGuildUpdates(tx, delegate, g.id, { before: 'not-a-uuid' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // The delegate's own row is a valid position.
    expect(
      (await run((tx) => listManagedGuildUpdates(tx, delegate, g.id, { before: own }))).updates,
    ).toEqual([]);
    // The Founder may use any row of this Guild as a cursor, but never another Guild's row.
    expect(
      (await run((tx) => listManagedGuildUpdates(tx, founder, g.id, { before: theirs }))).updates,
    ).toBeDefined();
    await expect(
      run((tx) => listManagedGuildUpdates(tx, founder, g.id, { before: foreign })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // A cursor is judged only after authority: an outsider is FORBIDDEN, not told whether the cursor exists.
    const outsider = await person();
    for (const before of [own, crypto.randomUUID()])
      await expect(
        run((tx) => listManagedGuildUpdates(tx, outsider, g.id, { before })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('DEC-2026-11-14-04: a cursor withdrawn after serving still pages; a row that no longer exists is refused', async () => {
    const { founder, guild: g } = await guild('news-mw');
    const ids: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const id = (await draft(founder, g.id, `W ${i}`, 'Body', `mw-${i}`)).update.id;
      await publish(founder, g.id, id, `mw-p-${i}`);
      ids.push(id);
    }
    const first = await run((tx) => listManagedGuildUpdates(tx, founder, g.id, { limit: 2 }));
    expect(first.updates.map((u) => u.id)).toEqual([ids[3], ids[2]]);
    await withdraw(founder, g.id, ids[2], 'mw-w');
    const second = await run((tx) =>
      listManagedGuildUpdates(tx, founder, g.id, { limit: 2, before: first.nextCursor! }),
    );
    expect(second.updates.map((u) => u.id)).toEqual([ids[1], ids[0]]);
    // Withdrawn rows never appear in results.
    expect(
      (await run((tx) => listManagedGuildUpdates(tx, founder, g.id))).updates.map((u) => u.id),
    ).toEqual([ids[3], ids[1], ids[0]]);
    // Updates are never deleted by the application; if retention removes a row, its cursor is unknown.
    await withoutUpdateGuard(() =>
      db.$executeRawUnsafe(`DELETE FROM "GuildUpdate" WHERE "id"=$1::uuid`, ids[0]),
    );
    await expect(
      run((tx) => listManagedGuildUpdates(tx, founder, g.id, { before: ids[0] })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
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

  it('#296-4: each update is its own aggregate whose events carry a distinct, increasing aggregateVersion', async () => {
    const { founder, guild: g } = await guild('news-ver');
    const versions = (updateId: string) =>
      db.$queryRawUnsafe<{ eventType: string; aggregateId: string; aggregateVersion: number }[]>(
        `SELECT "eventType","aggregateId","aggregateVersion" FROM "AuditEvent" WHERE "payload"->>'guildUpdateId'=$1 ORDER BY "aggregateVersion"`,
        updateId,
      );
    const a = (await draft(founder, g.id, 'A', 'first')).update.id;
    const b = (await draft(founder, g.id, 'B', 'second')).update.id;
    await publish(founder, g.id, a);
    await withdraw(founder, g.id, a);
    await withdraw(founder, g.id, b); // withdrawn straight from a draft
    expect(await versions(a)).toEqual([
      { eventType: 'guild.update_drafted.v1', aggregateId: a, aggregateVersion: 1 },
      { eventType: 'guild.update_published.v1', aggregateId: a, aggregateVersion: 2 },
      { eventType: 'guild.update_withdrawn.v1', aggregateId: a, aggregateVersion: 3 },
    ]);
    expect(await versions(b)).toEqual([
      { eventType: 'guild.update_drafted.v1', aggregateId: b, aggregateVersion: 1 },
      { eventType: 'guild.update_withdrawn.v1', aggregateId: b, aggregateVersion: 2 },
    ]);
    // Every update event in the Guild is unique by (aggregateId, aggregateVersion): consumers can order and dedupe.
    const dupes = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM "AuditEvent" WHERE "guildId"=$1 AND "eventType" LIKE 'guild.update_%' GROUP BY "aggregateId","aggregateVersion" HAVING count(*)>1) d`,
      g.id,
    );
    expect(dupes[0].n).toBe(0);
  });

  it('#296-4: a publish racing a withdrawal of the same update serializes into versions 2 and 3', async () => {
    const { founder, guild: g } = await guild('news-race');
    const id = (await draft(founder, g.id)).update.id;
    const settled = await Promise.allSettled([
      publish(founder, g.id, id),
      withdraw(founder, g.id, id),
    ]);
    // Either order may win (a publish after a withdrawal is refused); the events that committed have distinct, gapless versions.
    expect(settled.some((r) => r.status === 'fulfilled')).toBe(true);
    const rows = await db.$queryRawUnsafe<{ v: number }[]>(
      `SELECT "aggregateVersion" AS v FROM "AuditEvent" WHERE "aggregateId"=$1 ORDER BY 1`,
      id,
    );
    expect(rows.map((r) => r.v)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('#296-5: publication time is the database clock whatever a direct writer supplies', async () => {
    const { founder, guild: g } = await guild('news-pin');
    const id = (await draft(founder, g.id)).update.id;
    const stamped = async (supplied: string) => {
      let seen = 0;
      // Inspect inside the transaction, then roll back: the forged publication never commits.
      await db
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "GuildUpdate" SET "state"='PUBLISHED',"publishedAt"=$2::timestamptz,"publishedByAccountId"=$3,"publishReceiptId"="draftReceiptId" WHERE "id"=$1::uuid`,
            id,
            supplied,
            founder.accountId,
          );
          const [row] = await tx.$queryRawUnsafe<{ at: Date }[]>(
            `SELECT "publishedAt" AS at FROM "GuildUpdate" WHERE "id"=$1::uuid`,
            id,
          );
          seen = row.at.getTime();
          throw new Error('rollback');
        })
        .catch((e: Error) => {
          if (e.message !== 'rollback') throw e;
        });
      return seen;
    };
    for (const supplied of ['2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
      expect(Math.abs((await stamped(supplied)) - Date.now()), supplied).toBeLessThan(60_000);
    }
    // The real command is unaffected.
    const published = await publish(founder, g.id, id);
    expect(Math.abs(Date.parse(published.update.publishedAt!) - Date.now())).toBeLessThan(60_000);
  });

  describe('DEC-2026-11-14-05 (b): publish and withdraw replays re-check live authority', () => {
    const handOver = async (founder: GuildActor, guildId: string, to: GuildActor) => {
      const ownerHost = { allowNewWrites: true, authorizeOwnershipTransfer: async () => true };
      const proposed = await run((tx) =>
        proposeOwnershipTransfer(
          tx,
          cmd(founder, {
            guildId,
            toAccountId: to.accountId,
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          }),
          ownerHost,
        ),
      );
      await run((tx) =>
        respondOwnershipTransfer(
          tx,
          cmd(to, { guildId, transferId: proposed.transfer.id, decision: 'ACCEPT' }),
          ownerHost,
        ),
      );
    };

    it('refuses a publish replay by an account that is no longer the Founder, and still replays it for the Founder', async () => {
      const { founder, guild: g } = await guild('dec05-publish');
      const heir = await person();
      const id = (await draft(founder, g.id, 'Hello', 'World')).update.id;
      expect((await publish(founder, g.id, id, 'pub-1')).status).toBe('EXECUTED');
      expect((await publish(founder, g.id, id, 'pub-1')).status).toBe('REPLAYED');
      await handOver(founder, g.id, heir);
      await expect(publish(founder, g.id, id, 'pub-1')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('refuses a publish replay by a former Founder who still holds a profile grant (publish needs Founder status)', async () => {
      const { founder, guild: g } = await guild('dec05-publish-grant');
      const heir = await person();
      const id = (await draft(founder, g.id, 'Hello', 'World')).update.id;
      await publish(founder, g.id, id, 'pub-1');
      await handOver(founder, g.id, heir);
      await grantRow(g.id, founder);
      await expect(publish(founder, g.id, id, 'pub-1')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('refuses a withdraw replay by a delegate whose profile authority has since ended, and by a former Founder', async () => {
      const { founder, guild: g } = await guild('dec05-withdraw');
      const author = await person();
      const heir = await person();
      await grantRow(g.id, author);
      const mine = (await draft(author, g.id, 'Mine', 'Body')).update.id;
      expect((await withdraw(author, g.id, mine, 'wd-1')).status).toBe('EXECUTED');
      expect((await withdraw(author, g.id, mine, 'wd-1')).status).toBe('REPLAYED');
      await db.$executeRawUnsafe(
        `UPDATE "GuildRoleGrant" SET "revokedAt"=clock_timestamp() WHERE "granteeAccountId"=$1`,
        author.accountId,
      );
      await expect(withdraw(author, g.id, mine, 'wd-1')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      // The Founder's own withdrawal stops replaying once they hand the Guild over.
      const pub = (await draft(founder, g.id, 'Public', 'Body')).update.id;
      await publish(founder, g.id, pub);
      expect((await withdraw(founder, g.id, pub, 'wd-2')).status).toBe('EXECUTED');
      expect((await withdraw(founder, g.id, pub, 'wd-2')).status).toBe('REPLAYED');
      await handOver(founder, g.id, heir);
      await expect(withdraw(founder, g.id, pub, 'wd-2')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('keeps replaying for an author whose profile grant is still live, and a former Founder holding a new profile grant may replay a withdrawal', async () => {
      const { founder, guild: g } = await guild('dec05-live');
      const author = await person();
      const heir = await person();
      await grantRow(g.id, author);
      const mine = (await draft(author, g.id, 'Mine', 'Body')).update.id;
      await withdraw(author, g.id, mine, 'wd-live');
      expect((await withdraw(author, g.id, mine, 'wd-live')).status).toBe('REPLAYED');
      const pub = (await draft(founder, g.id, 'Public', 'Body')).update.id;
      await publish(founder, g.id, pub);
      await withdraw(founder, g.id, pub, 'wd-former');
      await handOver(founder, g.id, heir);
      await grantRow(g.id, founder);
      expect((await withdraw(founder, g.id, pub, 'wd-former')).status).toBe('REPLAYED');
    });
  });
});
