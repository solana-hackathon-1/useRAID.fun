import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import {
  activateGuild,
  editGuildProfile,
  hasGuildAuthority,
  readManagedGuild,
  readPublicGuild,
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
integration('T009 persisted Guild storage', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    operators.clear();
  });
  afterAll(() => db.$disconnect());

  it('activates a Guild from an own draft only for an approving operator; the draft owner becomes Founder', async () => {
    const founder = await person();
    const operator = await person();
    const draft = await draftFor(founder, 'acme');
    const input = {
      guildDraftId: draft.id,
      expectedDraftRevision: draft.revision,
      activationRef: 'evidence-1',
    };
    // The draft owner cannot self-activate; nor can an unapproved account.
    await expect(run((tx) => activateGuild(tx, cmd(founder, input), host()))).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    await expect(
      run((tx) => activateGuild(tx, cmd(operator, input), host())),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    operators.add(operator.accountId);
    await expect(
      run((tx) => activateGuild(tx, cmd(operator, input), host(false))),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    const done = await run((tx) => activateGuild(tx, cmd(operator, input, 'activate-1'), host()));
    expect(done).toMatchObject({
      status: 'EXECUTED',
      guild: {
        slug: 'acme',
        name: 'Synthetic acme',
        founderAccountId: founder.accountId,
        revision: 1,
        state: 'ACTIVE',
      },
    });
    const replay = await run((tx) => activateGuild(tx, cmd(operator, input, 'activate-1'), host()));
    expect(replay.status).toBe('REPLAYED');
    expect(replay.guild.id).toBe(done.guild.id);
    // One Guild per draft; a stale draft revision is refused before anything is written.
    await expect(
      run((tx) => activateGuild(tx, cmd(operator, input, 'activate-2'), host())),
    ).rejects.toMatchObject({ code: 'GUILD_EXISTS' });
    const other = await draftFor(await person(), 'other');
    await expect(
      run((tx) =>
        activateGuild(
          tx,
          cmd(
            operator,
            { ...input, guildDraftId: other.id, expectedDraftRevision: 9 },
            'activate-3',
          ),
          host(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const [{ audits }] = await db.$queryRawUnsafe<{ audits: number }[]>(
      `SELECT count(*)::int AS audits FROM "AuditEvent" WHERE "eventType"='guild.activated.v1' AND "guildId"=$1`,
      done.guild.id,
    );
    expect(audits).toBe(1);
  });

  it('exposes only the approved public allowlist and nothing private', async () => {
    const { guild: g } = await guild('public-one');
    const publicView = await run((tx) => readPublicGuild(tx, 'public-one'));
    expect(publicView).toEqual({
      id: g.id,
      slug: 'public-one',
      name: 'Synthetic public-one',
      description: 'Synthetic description',
      primaryToken: null,
    });
    const json = JSON.stringify(publicView);
    for (const secret of ['founder', 'activation', 'evidence-record', 'Grant', 'revision'])
      expect(json).not.toContain(secret);
    await expect(run((tx) => readPublicGuild(tx, 'missing'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(run((tx) => readPublicGuild(tx, 'Not A Slug'))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('lets the Founder edit the profile with a new immutable version, receipt and audit; replays safely', async () => {
    const { founder, guild: g } = await guild();
    const first = await edit(founder, g.id, 1, { description: 'A better description' }, 'edit-1');
    expect(first).toMatchObject({
      status: 'EXECUTED',
      guild: { revision: 2, description: 'A better description', name: g.name },
    });
    expect(
      (await edit(founder, g.id, 1, { description: 'A better description' }, 'edit-1')).status,
    ).toBe('REPLAYED');
    await expect(edit(founder, g.id, 1, { name: 'Stale' }, 'edit-2')).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(edit(founder, g.id, 2, {}, 'edit-3')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(edit(founder, g.id, 2, { slug: 'renamed' }, 'edit-4')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(edit(founder, g.id, 2, { name: 'New' }, 'edit-5', false)).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    const versions = await db.$queryRawUnsafe<{ revision: number }[]>(
      `SELECT "revision" FROM "GuildProfileVersion" WHERE "guildId"=$1::uuid ORDER BY "revision"`,
      g.id,
    );
    expect(versions.map((v) => v.revision)).toEqual([1, 2]);
    const [{ audits }] = await db.$queryRawUnsafe<{ audits: number }[]>(
      `SELECT count(*)::int AS audits FROM "AuditEvent" WHERE "eventType"='guild.profile_edited.v1' AND "guildId"=$1`,
      g.id,
    );
    expect(audits).toBe(1);
  });

  it('denies a token holder, a stranger and a grant for another Guild (AC07, cross-Guild writes)', async () => {
    const a = await guild('guild-a');
    const b = await guild('guild-b');
    const stranger = await person();
    // Holder eligibility is not an input to Guild administration at all: a plain account has no authority.
    await expect(edit(stranger, a.guild.id, 1, { name: 'Hijack' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // A Founder of B cannot write A; a grant on B does not reach A.
    await expect(edit(b.founder, a.guild.id, 1, { name: 'Hijack' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const delegate = await person();
    await grant(b.guild.id, delegate);
    await expect(edit(delegate, a.guild.id, 1, { name: 'Hijack' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await edit(delegate, b.guild.id, 1, { name: 'Allowed on B' })).guild.name).toBe(
      'Allowed on B',
    );
    const unchanged = await run((tx) => readPublicGuild(tx, 'guild-a'));
    expect(unchanged.name).toBe('Synthetic guild-a');
  });

  it('honors delegated field scope, expiry and revocation, and never lets a restricted account act', async () => {
    const { founder, guild: g } = await guild();
    const nameOnly = await person();
    await grant(g.id, nameOnly, { fields: ['name'] });
    await expect(
      edit(nameOnly, g.id, 1, { description: 'Not granted' }, 'd-1'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      edit(nameOnly, g.id, 1, { name: 'Renamed', description: 'Both' }, 'd-2'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await edit(nameOnly, g.id, 1, { name: 'Renamed' }, 'd-3')).guild.revision).toBe(2);
    const expired = await person();
    await grant(g.id, expired, {
      validFrom: new Date(Date.now() - 7200000).toISOString(),
      expiresAt: new Date(Date.now() - 3600000).toISOString(),
    });
    await expect(edit(expired, g.id, 2, { name: 'Late' }, 'd-4')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const future = await person();
    await grant(g.id, future, { validFrom: new Date(Date.now() + 3600000).toISOString() });
    await expect(edit(future, g.id, 2, { name: 'Early' }, 'd-5')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const revoked = await person();
    await grant(g.id, revoked, { revoked: true });
    await expect(edit(revoked, g.id, 2, { name: 'Revoked' }, 'd-6')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await db.user.update({ where: { id: founder.accountId }, data: { suspended: true } });
    await expect(edit(founder, g.id, 2, { name: 'Suspended' }, 'd-7')).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
  });

  it('keeps work, treasury and dispute authority separate from profile administration (T009-A02)', async () => {
    const { founder, guild: g } = await guild();
    const treasurer = await person();
    const manager = await person();
    const judge = await person();
    await grant(g.id, treasurer, { kind: 'TREASURY', fields: [] });
    await grant(g.id, manager, { kind: 'WORK', fields: [] });
    await grant(g.id, judge, { kind: 'DISPUTE', fields: [] });
    const can = (who: GuildActor, kind: 'PROFILE' | 'WORK' | 'TREASURY' | 'DISPUTE') =>
      run((tx) => hasGuildAuthority(tx, who.accountId, g.id, kind));
    // The Founder runs the profile and listings but holds no treasury or dispute power by role alone.
    expect([
      await can(founder, 'PROFILE'),
      await can(founder, 'WORK'),
      await can(founder, 'TREASURY'),
      await can(founder, 'DISPUTE'),
    ]).toEqual([true, true, false, false]);
    expect([
      await can(treasurer, 'TREASURY'),
      await can(treasurer, 'PROFILE'),
      await can(treasurer, 'WORK'),
      await can(treasurer, 'DISPUTE'),
    ]).toEqual([true, false, false, false]);
    expect([
      await can(manager, 'WORK'),
      await can(manager, 'PROFILE'),
      await can(manager, 'TREASURY'),
    ]).toEqual([true, false, false]);
    expect([await can(judge, 'DISPUTE'), await can(judge, 'TREASURY')]).toEqual([true, false]);
    await expect(edit(treasurer, g.id, 1, { name: 'Via treasury' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(edit(judge, g.id, 1, { name: 'Via dispute' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('shows a manager only their own authority and refuses everyone else', async () => {
    const { founder, guild: g } = await guild();
    const manager = await person();
    await grant(g.id, manager, { kind: 'WORK', fields: [] });
    const stranger = await person();
    const seen = await run((tx) => readManagedGuild(tx, founder, g.id));
    expect(seen).toMatchObject({
      guild: { id: g.id, founderAccountId: founder.accountId },
      authority: { founder: true, kinds: ['PROFILE', 'WORK'] },
    });
    expect((await run((tx) => readManagedGuild(tx, manager, g.id))).authority).toMatchObject({
      founder: false,
      kinds: ['WORK'],
    });
    await expect(run((tx) => readManagedGuild(tx, stranger, g.id))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rejects direct writers that would rewrite identity, history or authority records', async () => {
    const { guild: g } = await guild();
    const attempt = (sql: string) =>
      db.$executeRawUnsafe(sql).then(
        () => 'accepted',
        (e: Error) => (/Guild/.test(e.message) ? 'guarded' : 'other:' + e.message),
      );
    expect(await attempt(`UPDATE "Guild" SET "slug"='renamed' WHERE "id"='${g.id}'`)).toBe(
      'guarded',
    );
    expect(
      await attempt(
        `UPDATE "Guild" SET "founderAccountId"="activatedByAccountId" WHERE "id"='${g.id}'`,
      ),
    ).toBe('guarded');
    expect(await attempt(`DELETE FROM "Guild" WHERE "id"='${g.id}'`)).toBe('guarded');
    expect(
      await attempt(`UPDATE "GuildProfileVersion" SET "name"='x' WHERE "guildId"='${g.id}'`),
    ).toBe('guarded');
    expect(await attempt(`DELETE FROM "GuildProfileVersion" WHERE "guildId"='${g.id}'`)).toBe(
      'guarded',
    );
  });

  it('refuses activation by the draft owner even when the host would approve the owner', async () => {
    const founder = await person();
    const draft = await draftFor(founder, 'self-approved');
    operators.add(founder.accountId);
    await expect(
      run((tx) =>
        activateGuild(
          tx,
          cmd(founder, {
            guildDraftId: draft.id,
            expectedDraftRevision: draft.revision,
            activationRef: 'self',
          }),
          host(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "Guild"')).toEqual([]);
  });

  it('takes the draft owner row before the draft row, as the draft writer does, so the two cannot deadlock', async () => {
    const founder = await person();
    const operator = await person();
    operators.add(operator.accountId);
    const draft = await draftFor(founder, 'lock-order');
    const locker = new PrismaClient({ transactionOptions: { timeout: 30000 } });
    const observer = new PrismaClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    // Stands in for the draft writer, which holds the owner's User row while it waits for the draft row.
    const holder = locker.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "User" WHERE "id"=$1 FOR NO KEY UPDATE',
        founder.accountId,
      );
      locked();
      await gate;
    });
    try {
      await holding;
      const activation = run((tx) =>
        activateGuild(
          tx,
          cmd(operator, {
            guildDraftId: draft.id,
            expectedDraftRevision: draft.revision,
            activationRef: 'order',
          }),
          host(),
        ),
      );
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const rows = (await observer.$queryRawUnsafe(
          `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM "User"%' AND pid<>pg_backend_pid()`,
        )) as unknown[];
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      // The activation waits on the owner row and must not already hold the draft row.
      await expect(
        observer.$transaction((tx) =>
          tx.$queryRawUnsafe(
            'SELECT "id" FROM "GuildDraft" WHERE "id"=$1::uuid FOR UPDATE NOWAIT',
            draft.id,
          ),
        ),
      ).resolves.toHaveLength(1);
      release();
      expect((await activation).status).toBe('EXECUTED');
    } finally {
      release();
      await holder;
      await Promise.all([locker.$disconnect(), observer.$disconnect()]);
    }
  });

  it('replays an edit only to an actor whose current grant still covers its fields, and returns the stored result', async () => {
    const { founder, guild: g } = await guild();
    const delegate = await person();
    await grant(g.id, delegate, { fields: ['name', 'description'] });
    const first = await edit(delegate, g.id, 1, { description: 'Delegate wording' }, 'replay-1');
    expect(first.guild).toMatchObject({ revision: 2, description: 'Delegate wording' });
    await edit(founder, g.id, 2, { name: 'Founder rename' }, 'founder-1');
    // Later revisions are not part of the stored result.
    const again = await edit(delegate, g.id, 1, { description: 'Delegate wording' }, 'replay-1');
    expect(again).toMatchObject({
      status: 'REPLAYED',
      guild: { revision: 2, name: g.name, description: 'Delegate wording' },
    });
    // Narrow the grant to name only: the same key no longer reaches the description edit.
    await db.$executeRawUnsafe(
      `UPDATE "GuildRoleGrant" SET "revokedAt"=clock_timestamp() WHERE "granteeAccountId"=$1`,
      delegate.accountId,
    );
    await grant(g.id, delegate, { fields: ['name'] });
    await expect(
      edit(delegate, g.id, 1, { description: 'Delegate wording' }, 'replay-1'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
