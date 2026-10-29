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
  revokeGuildRole,
  GUILD_GRANT_LIMIT,
  type GuildActor,
} from '../src/guild-profiles/guild-storage';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import type { SqlBinding } from '../src/command-receipts';
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

const giveRole = (
  actor: GuildActor,
  guildId: string,
  input: Record<string, unknown>,
  key?: string,
  writes = true,
) => run((tx) => grantGuildRole(tx, cmd(actor, { guildId, ...input }, key), host(writes)));
const takeRole = (
  actor: GuildActor,
  guildId: string,
  grantId: string,
  key?: string,
  writes = true,
) => run((tx) => revokeGuildRole(tx, cmd(actor, { guildId, grantId }, key), host(writes)));
const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const can = (who: GuildActor, guildId: string, kind: 'PROFILE' | 'WORK' | 'TREASURY' | 'DISPUTE') =>
  run((tx) => hasGuildAuthority(tx, who.accountId, guildId, kind));
integration('T009 Guild role grants and revocation', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    operators.clear();
  });
  afterAll(() => db.$disconnect());

  it('lets the Founder delegate a field-scoped profile role, audited and replay-safe', async () => {
    const { founder, guild: g } = await guild();
    const delegate = await person();
    const made = await giveRole(
      founder,
      g.id,
      { granteeAccountId: delegate.accountId, kind: 'PROFILE', fields: ['name'] },
      'grant-1',
    );
    expect(made).toMatchObject({
      status: 'EXECUTED',
      grant: {
        guildId: g.id,
        granteeAccountId: delegate.accountId,
        kind: 'PROFILE',
        fields: ['name'],
        canDelegate: false,
        grantedByAccountId: founder.accountId,
        revokedAt: null,
      },
    });
    expect(
      (
        await giveRole(
          founder,
          g.id,
          { granteeAccountId: delegate.accountId, kind: 'PROFILE', fields: ['name'] },
          'grant-1',
        )
      ).grant.id,
    ).toBe(made.grant.id);
    await expect(
      giveRole(
        founder,
        g.id,
        { granteeAccountId: delegate.accountId, kind: 'PROFILE', fields: ['description'] },
        'grant-1',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await edit(delegate, g.id, 1, { name: 'By delegate' })).guild.name).toBe('By delegate');
    await expect(edit(delegate, g.id, 2, { description: 'Not granted' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const [{ audits }] = await db.$queryRawUnsafe<{ audits: number }[]>(
      `SELECT count(*)::int AS audits FROM "AuditEvent" WHERE "eventType"='guild.role_granted.v1' AND "guildId"=$1`,
      g.id,
    );
    expect(audits).toBe(1);
  });

  it('refuses grants by strangers, by non-delegating grantees, to the Founder, and across Guilds', async () => {
    const a = await guild('grants-a');
    const b = await guild('grants-b');
    const stranger = await person();
    const target = await person();
    const body = (who: GuildActor) => ({
      granteeAccountId: who.accountId,
      kind: 'PROFILE',
      fields: ['name'],
    });
    await expect(giveRole(stranger, a.guild.id, body(target))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(giveRole(b.founder, a.guild.id, body(target))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(giveRole(a.founder, a.guild.id, body(a.founder))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      giveRole(a.founder, a.guild.id, { granteeAccountId: a.founder.accountId, kind: 'TREASURY' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const plain = await person();
    await giveRole(a.founder, a.guild.id, {
      granteeAccountId: plain.accountId,
      kind: 'PROFILE',
      fields: ['name'],
    });
    await expect(giveRole(plain, a.guild.id, body(target))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const treasurer = await person();
    await giveRole(a.founder, a.guild.id, {
      granteeAccountId: treasurer.accountId,
      kind: 'TREASURY',
    });
    await expect(giveRole(treasurer, a.guild.id, body(target))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const suspended = await person();
    await db.user.update({ where: { id: suspended.accountId }, data: { suspended: true } });
    await expect(giveRole(a.founder, a.guild.id, body(suspended))).rejects.toMatchObject({
      code: 'ACCOUNT_RESTRICTED',
    });
    await expect(
      giveRole(a.founder, a.guild.id, { granteeAccountId: 'no-such-account', kind: 'WORK' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(giveRole(a.founder, a.guild.id, body(target), 'w-1', false)).rejects.toMatchObject(
      { code: 'WRITES_DISABLED' },
    );
    // Malformed requests: fields only on PROFILE, profile needs fields, no delegation for other kinds, past expiry.
    for (const bad of [
      { kind: 'WORK', fields: ['name'] },
      { kind: 'PROFILE' },
      { kind: 'PROFILE', fields: ['slug'] },
      { kind: 'TREASURY', canDelegate: true },
      { kind: 'PROFILE', fields: ['name'], expiresAt: future(-1000) },
      { kind: 'PROFILE', fields: ['name'], extra: 1 },
    ])
      await expect(
        giveRole(a.founder, a.guild.id, { granteeAccountId: target.accountId, ...bad }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await db.$queryRawUnsafe(
        'SELECT 1 FROM "GuildRoleGrant" WHERE "granteeAccountId"=$1',
        target.accountId,
      ),
    ).toEqual([]);
  });

  it('bounds redelegation: a delegating grantee may pass on only a subset of their own fields, once, and not past their expiry', async () => {
    const { founder, guild: g } = await guild();
    const lead = await person();
    const helper = await person();
    const expiry = future(3600000);
    await giveRole(founder, g.id, {
      granteeAccountId: lead.accountId,
      kind: 'PROFILE',
      fields: ['name'],
      canDelegate: true,
      expiresAt: expiry,
    });
    // A delegate with bounded cover must give an explicit expiry no later than their own.
    const sub = await giveRole(lead, g.id, {
      granteeAccountId: helper.accountId,
      kind: 'PROFILE',
      fields: ['name'],
      expiresAt: future(1800000),
    });
    expect(sub.grant).toMatchObject({ grantedByAccountId: lead.accountId, canDelegate: false });
    for (const over of [
      { kind: 'PROFILE', fields: ['description'] },
      { kind: 'PROFILE', fields: ['name', 'description'] },
      { kind: 'PROFILE', fields: ['name'], canDelegate: true },
      { kind: 'PROFILE', fields: ['name'], expiresAt: future(7200000) },
      { kind: 'PROFILE', fields: ['name'], expiresAt: null },
      { kind: 'WORK' },
      { kind: 'TREASURY' },
    ])
      await expect(
        giveRole(lead, g.id, { granteeAccountId: (await person()).accountId, ...over }),
        JSON.stringify(over),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await edit(helper, g.id, 1, { name: 'Helper edit' })).guild.revision).toBe(2);
    // The helper cannot delegate further.
    await expect(
      giveRole(helper, g.id, {
        granteeAccountId: (await person()).accountId,
        kind: 'PROFILE',
        fields: ['name'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps treasury and dispute as separate, explicitly granted authority', async () => {
    const { founder, guild: g } = await guild();
    const treasurer = await person();
    await giveRole(founder, g.id, { granteeAccountId: treasurer.accountId, kind: 'TREASURY' });
    expect([
      await can(treasurer, g.id, 'TREASURY'),
      await can(treasurer, g.id, 'PROFILE'),
      await can(founder, g.id, 'TREASURY'),
    ]).toEqual([true, false, false]);
    await expect(edit(treasurer, g.id, 1, { name: 'Via treasury' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('revokes by the Founder, the issuer or the grantee; others and other Guilds cannot; revocation takes effect at once', async () => {
    const a = await guild('revoke-a');
    const b = await guild('revoke-b');
    const holder = await person();
    const stranger = await person();
    const grantOf = async (kind = 'WORK') =>
      (await giveRole(a.founder, a.guild.id, { granteeAccountId: holder.accountId, kind })).grant
        .id;
    const one = await grantOf();
    await expect(takeRole(stranger, a.guild.id, one)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(takeRole(b.founder, a.guild.id, one)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(takeRole(a.founder, b.guild.id, one)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      takeRole(a.founder, a.guild.id, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await can(holder, a.guild.id, 'WORK')).toBe(true);
    const done = await takeRole(a.founder, a.guild.id, one, 'rv-1');
    expect(done).toMatchObject({ status: 'EXECUTED', grant: { id: one } });
    expect(done.grant.revokedAt).not.toBeNull();
    expect((await takeRole(a.founder, a.guild.id, one, 'rv-1')).status).toBe('REPLAYED');
    expect(await can(holder, a.guild.id, 'WORK')).toBe(false);
    // No revision is involved, so a client that re-reads and retries must not loop on a conflict code.
    await expect(takeRole(a.founder, a.guild.id, one, 'rv-2')).rejects.toMatchObject({
      code: 'GRANT_REVOKED',
    });
    // The grantee may surrender their own role.
    const two = await grantOf('DISPUTE');
    expect((await takeRole(holder, a.guild.id, two)).grant.revokedAt).not.toBeNull();
    // A revoked profile grant stops editing immediately.
    const editor = await person();
    const three = (
      await giveRole(a.founder, a.guild.id, {
        granteeAccountId: editor.accountId,
        kind: 'PROFILE',
        fields: ['name'],
      })
    ).grant.id;
    await edit(editor, a.guild.id, 1, { name: 'Before' });
    await takeRole(a.founder, a.guild.id, three);
    await expect(edit(editor, a.guild.id, 2, { name: 'After' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const [{ audits }] = await db.$queryRawUnsafe<{ audits: number }[]>(
      `SELECT count(*)::int AS audits FROM "AuditEvent" WHERE "eventType"='guild.role_revoked.v1' AND "guildId"=$1`,
      a.guild.id,
    );
    expect(audits).toBe(3);
  });

  it('revoking a delegating grant also revokes what that grantee passed on', async () => {
    const { founder, guild: g } = await guild();
    const lead = await person();
    const helper = await person();
    const leadGrant = (
      await giveRole(founder, g.id, {
        granteeAccountId: lead.accountId,
        kind: 'PROFILE',
        fields: ['name'],
        canDelegate: true,
      })
    ).grant.id;
    const direct = await person();
    const directGrant = (
      await giveRole(founder, g.id, {
        granteeAccountId: direct.accountId,
        kind: 'PROFILE',
        fields: ['name'],
      })
    ).grant.id;
    const subGrant = (
      await giveRole(lead, g.id, {
        granteeAccountId: helper.accountId,
        kind: 'PROFILE',
        fields: ['name'],
      })
    ).grant.id;
    await takeRole(founder, g.id, leadGrant);
    const rows = await db.$queryRawUnsafe<{ id: string; revoked: boolean }[]>(
      `SELECT "id"::text,"revokedAt" IS NOT NULL AS revoked FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid`,
      g.id,
    );
    const state = Object.fromEntries(rows.map((r) => [r.id, r.revoked]));
    expect(state[leadGrant]).toBe(true);
    expect(state[subGrant]).toBe(true);
    // The Founder's own direct grant to another account is untouched.
    expect(state[directGrant]).toBe(false);
    await expect(edit(helper, g.id, 1, { name: 'Orphaned delegate' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('caps live grants per Guild', async () => {
    const { founder, guild: g } = await guild();
    const target = await person();
    await db.$executeRawUnsafe(
      `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","grantedByAccountId") SELECT $1::uuid,$2,'WORK',$3 FROM generate_series(1,$4::int)`,
      g.id,
      target.accountId,
      founder.accountId,
      String(GUILD_GRANT_LIMIT),
    );
    await expect(
      giveRole(founder, g.id, { granteeAccountId: (await person()).accountId, kind: 'WORK' }),
    ).rejects.toMatchObject({ code: 'GRANT_LIMIT' });
  });

  it('serializes revocation with profile edits on the Guild row', async () => {
    const { founder, guild: g } = await guild();
    const editor = await person();
    const id = (
      await giveRole(founder, g.id, {
        granteeAccountId: editor.accountId,
        kind: 'PROFILE',
        fields: ['name'],
      })
    ).grant.id;
    const locker = new PrismaClient({ transactionOptions: { timeout: 30000 } });
    const observer = new PrismaClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    // Stands in for an edit in flight: it holds the Guild row until it commits.
    const holder = locker.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "Guild" WHERE "id"=$1::uuid FOR UPDATE', g.id);
      locked();
      await gate;
    });
    try {
      await holding;
      const revoking = takeRole(founder, g.id, id);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const rows = (await observer.$queryRawUnsafe(
          `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%"Guild"%' AND pid<>pg_backend_pid()`,
        )) as unknown[];
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      release();
      expect((await revoking).status).toBe('EXECUTED');
    } finally {
      release();
      await holder;
      await Promise.all([locker.$disconnect(), observer.$disconnect()]);
    }
  });

  it('still revokes a delegating grant when the grantee left many expired sub-grants behind', async () => {
    const { founder, guild: g } = await guild();
    const lead = await person();
    const leadGrant = (
      await giveRole(founder, g.id, {
        granteeAccountId: lead.accountId,
        kind: 'PROFILE',
        fields: ['name'],
        canDelegate: true,
      })
    ).grant.id;
    const live = (
      await giveRole(lead, g.id, {
        granteeAccountId: (await person()).accountId,
        kind: 'PROFILE',
        fields: ['name'],
        expiresAt: future(3600000),
      })
    ).grant.id;
    const other = await person();
    // Expired rows are not counted by any cap, so they can pile up without bound.
    await db.$executeRawUnsafe(
      `INSERT INTO "GuildRoleGrant" ("guildId","granteeAccountId","kind","fields","validFrom","expiresAt","grantedByAccountId") SELECT $1::uuid,$2,'PROFILE',ARRAY['name'],clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',$3 FROM generate_series(1,25)`,
      g.id,
      other.accountId,
      lead.accountId,
    );
    expect((await takeRole(founder, g.id, leadGrant)).status).toBe('EXECUTED');
    const rows = await db.$queryRawUnsafe<{ id: string; revoked: boolean }[]>(
      `SELECT "id"::text,"revokedAt" IS NOT NULL AS revoked FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid AND "grantedByAccountId"=$2`,
      g.id,
      lead.accountId,
    );
    expect(rows.find((r) => r.id === live)?.revoked).toBe(true);
    // Expired rows grant nothing and are left as history.
    expect(rows.filter((r) => !r.revoked)).toHaveLength(25);
    expect(await can(lead, g.id, 'PROFILE')).toBe(false);
  });

  it('keeps passed-on grants only while the grantee still holds delegating cover for each field and for as long', async () => {
    const { founder, guild: g } = await guild();
    const lead = await person();
    const nameGrant = (
      await giveRole(founder, g.id, {
        granteeAccountId: lead.accountId,
        kind: 'PROFILE',
        fields: ['name'],
        canDelegate: true,
      })
    ).grant.id;
    await giveRole(founder, g.id, {
      granteeAccountId: lead.accountId,
      kind: 'PROFILE',
      fields: ['description'],
      canDelegate: true,
    });
    const x = await person();
    const y = await person();
    const xName = (
      await giveRole(lead, g.id, {
        granteeAccountId: x.accountId,
        kind: 'PROFILE',
        fields: ['name'],
      })
    ).grant.id;
    const yDescription = (
      await giveRole(lead, g.id, {
        granteeAccountId: y.accountId,
        kind: 'PROFILE',
        fields: ['description'],
      })
    ).grant.id;
    // Another delegating grant exists, but it does not cover `name`: X loses theirs, Y keeps theirs.
    await takeRole(founder, g.id, nameGrant);
    const revoked = async (id: string) =>
      (
        (await db.$queryRawUnsafe(
          `SELECT "revokedAt" IS NOT NULL AS r FROM "GuildRoleGrant" WHERE "id"=$1::uuid`,
          id,
        )) as { r: boolean }[]
      )[0].r;
    expect(await revoked(xName)).toBe(true);
    expect(await revoked(yDescription)).toBe(false);
  });

  it('revokes a passed-on grant that would outlive the remaining delegating cover', async () => {
    const { founder, guild: g } = await guild();
    const lead = await person();
    const unbounded = (
      await giveRole(founder, g.id, {
        granteeAccountId: lead.accountId,
        kind: 'PROFILE',
        fields: ['name'],
        canDelegate: true,
      })
    ).grant.id;
    await giveRole(founder, g.id, {
      granteeAccountId: lead.accountId,
      kind: 'PROFILE',
      fields: ['name'],
      canDelegate: true,
      expiresAt: future(3600000),
    });
    const x = await person();
    const forever = (
      await giveRole(lead, g.id, {
        granteeAccountId: x.accountId,
        kind: 'PROFILE',
        fields: ['name'],
      })
    ).grant.id;
    await takeRole(founder, g.id, unbounded);
    const [{ r }] = (await db.$queryRawUnsafe(
      `SELECT "revokedAt" IS NOT NULL AS r FROM "GuildRoleGrant" WHERE "id"=$1::uuid`,
      forever,
    )) as { r: boolean }[];
    expect(r).toBe(true);
  });

  it('#314-1: judges redelegation bounds at the locked instant and refuses when cover lapses between reads', async () => {
    const { founder, guild: g } = await guild();
    const lead = await person();
    const helper = await person();
    // Grants are immutable except for revocation, so the lapse is real: cover that expires two seconds from now.
    await giveRole(founder, g.id, {
      granteeAccountId: lead.accountId,
      kind: 'PROFILE',
      fields: ['name'],
      canDelegate: true,
      expiresAt: future(2000),
    });
    // Unrelated live delegating cover (another field) keeps the lead a delegator after the lapse.
    await giveRole(founder, g.id, {
      granteeAccountId: lead.accountId,
      kind: 'PROFILE',
      fields: ['description'],
      canDelegate: true,
    });
    const seen: { sql: string; bindings: readonly unknown[]; rows: unknown[] }[] = [];
    const attempt = run((tx) =>
      grantGuildRole(
        {
          dialect: tx.dialect,
          isolation: tx.isolation,
          async query<Row>(sql: string, bindings: readonly SqlBinding[]) {
            // The lead's only delegating cover for 'name' lapses after the policy read and before the bounds read.
            if (/CROSS JOIN LATERAL unnest/.test(sql))
              await tx.query(
                `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM max("expiresAt")-clock_timestamp()))+0.05)::text AS slept
                 FROM "GuildRoleGrant" WHERE "guildId"=$1::uuid AND "granteeAccountId"=$2`,
                [g.id, lead.accountId],
              );
            const rows = await tx.query<Row>(sql, bindings);
            seen.push({ sql, bindings, rows });
            return rows;
          },
        },
        cmd(lead, {
          guildId: g.id,
          granteeAccountId: helper.accountId,
          kind: 'PROFILE',
          fields: ['name'],
          expiresAt: null,
        }),
        host(),
      ),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [{ n }] = (await db.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "GuildRoleGrant" WHERE "granteeAccountId"=$1`,
      helper.accountId,
    )) as { n: number }[];
    expect(n).toBe(0);
    const now = (seen.find((q) => /AS now FROM "Guild"/.test(q.sql))!.rows[0] as { now: Date }).now;
    const bounds = seen.find((q) => /CROSS JOIN LATERAL unnest/.test(q.sql))!;
    expect(bounds.sql).not.toContain('clock_timestamp()');
    expect(bounds.bindings.map(String)).toContain(now.toISOString());
  });

  it('review follow-up: a delegate may pass on without an expiry only when their own cover has none', async () => {
    const { founder, guild: g } = await guild();
    const lead = await person();
    const bounded = await person();
    const helper = await person();
    const body = { kind: 'PROFILE', fields: ['name'], canDelegate: true };
    await giveRole(founder, g.id, { ...body, granteeAccountId: lead.accountId, expiresAt: null });
    await giveRole(founder, g.id, {
      ...body,
      granteeAccountId: bounded.accountId,
      expiresAt: future(3600000),
    });
    const pass = (from: GuildActor, expiresAt: string | null) =>
      giveRole(from, g.id, {
        granteeAccountId: helper.accountId,
        kind: 'PROFILE',
        fields: ['name'],
        expiresAt,
      });
    // Bounded cover: an explicit expiry no later than theirs is required.
    await expect(pass(bounded, null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(pass(bounded, future(7200000))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await pass(bounded, future(1800000))).grant.expiresAt).not.toBeNull();
    // Unbounded cover: nothing to be longer than, so no expiry is allowed (the cascade treats it as covering).
    expect((await pass(lead, null)).grant.expiresAt).toBeNull();
  });

  it('review follow-up: the kill switch stops new grants but never blocks taking authority away', async () => {
    const { founder, guild: g } = await guild();
    const holder = await person();
    const given = await giveRole(founder, g.id, {
      granteeAccountId: holder.accountId,
      kind: 'TREASURY',
    });
    await expect(
      giveRole(
        founder,
        g.id,
        { granteeAccountId: holder.accountId, kind: 'WORK' },
        'blocked',
        false,
      ),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    const revoked = await takeRole(founder, g.id, given.grant.id, 'incident', false);
    expect(revoked.grant.revokedAt).not.toBeNull();
    expect(await can(holder, g.id, 'TREASURY')).toBe(false);
  });

  it('review follow-up: an account with no standing is refused before any lock and learns nothing about Guilds or grants', async () => {
    const a = await guild('standing-a');
    const stranger = await person();
    const holder = await person();
    const given = await giveRole(a.founder, a.guild.id, {
      granteeAccountId: holder.accountId,
      kind: 'WORK',
    });
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (locked = r));
    const holderTx = db.$transaction(async (t) => {
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
      const missing = crypto.randomUUID();
      const body = { granteeAccountId: holder.accountId, kind: 'WORK' };
      expect(await outcome(giveRole(stranger, a.guild.id, body)), 'grant').toBe('FORBIDDEN');
      expect(await outcome(giveRole(stranger, missing, body)), 'grant, no Guild').toBe('FORBIDDEN');
      expect(await outcome(takeRole(stranger, a.guild.id, given.grant.id)), 'revoke').toBe(
        'FORBIDDEN',
      );
      expect(await outcome(takeRole(stranger, a.guild.id, missing)), 'revoke, no grant').toBe(
        'FORBIDDEN',
      );
      expect(await outcome(takeRole(stranger, missing, missing)), 'revoke, no Guild').toBe(
        'FORBIDDEN',
      );
    } finally {
      release();
      await holderTx;
    }
    // The Founder still learns that a grant id does not exist in their own Guild.
    await expect(takeRole(a.founder, a.guild.id, crypto.randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
