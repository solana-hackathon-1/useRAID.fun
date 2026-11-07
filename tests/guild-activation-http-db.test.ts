import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveGuildDraft } from '../src/guild-profiles/draft-storage';
import type { GuildActor } from '../src/guild-profiles/guild-storage';
import { createGuildActivationHandlers } from '../src/guild-profiles/guild-activation-http';
import { activateGuildAsOperator } from '../src/lib/guild-activation-host';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
let counter = 0;
async function person(): Promise<GuildActor> {
  const user = await db.user.create({ data: { handle: 'synthetic-activation-user-' + ++counter } });
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
async function draftOf(applicant: GuildActor, slug: string) {
  const saved = await run((tx) =>
    saveGuildDraft(
      tx,
      {
        actor: { ...applicant, actorAccountId: applicant.accountId },
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
  return saved.draft;
}
/** The real Root host (flag, allowlist, storage); only the session actor is supplied by the test. */
const handlersFor = (actor: GuildActor) =>
  createGuildActivationHandlers({
    version: 'v1',
    requestId: () => crypto.randomUUID(),
    actor: async () => actor,
    checkOrigin: () => undefined,
    rateLimit: async () => undefined,
    activate: activateGuildAsOperator,
  });
const send = (payload: unknown, key = 'key-' + crypto.randomUUID()) =>
  new Request('https://example.test/api/v1/guild-activations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(payload),
  });
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const count = async (table: string) =>
  Number(
    ((await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}"`)) as { n: number }[])[0]
      .n,
  );
const activate = (
  actor: GuildActor,
  draft: { id: string; revision: number },
  ref = 'ev-1',
  key?: string,
) =>
  handlersFor(actor).ACTIVATE(
    send(
      { guildDraftId: draft.id, expectedDraftRevision: draft.revision, activationRef: ref },
      key,
    ),
  );
const guildCount = () => count('Guild');
const open = (...operators: GuildActor[]) => {
  vi.stubEnv('GUILD_ACTIVATION_ENABLED', 'true');
  vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', operators.map((o) => o.accountId).join(','));
};

integration('Guild activation over HTTP against real storage', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    vi.unstubAllEnvs();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => db.$disconnect());

  it('activates an applicant draft for an allowlisted operator, recording approver, free-form ref and audit in one transaction', async () => {
    const applicant = await person();
    const operator = await person();
    const draft = await draftOf(applicant, 'ok-guild');
    open(operator);
    const ref = 'ticket:2026-11-07/ops.1_x-y';
    const response = await activate(operator, draft, ref, 'key-ok');
    expect(response.status).toBe(200);
    const view = await json(response);
    expect(view.status).toBe('EXECUTED');
    expect(view.guild).toMatchObject({
      slug: 'ok-guild',
      revision: 1,
      founderAccountId: applicant.accountId,
    });
    const rows = (await db.$queryRawUnsafe(
      `SELECT "founderAccountId","activatedByAccountId","activationRef","sourceDraftId"::text AS "draft","id"::text AS "id" FROM "Guild"`,
    )) as Record<string, string>[];
    expect(rows).toEqual([
      {
        founderAccountId: applicant.accountId,
        activatedByAccountId: operator.accountId,
        activationRef: ref,
        draft: draft.id,
        id: view.guild.id,
      },
    ]);
    // The audit record is the approver's own, written under the same receipt as the Guild.
    const audit = (await db.$queryRawUnsafe(
      `SELECT a."eventType",a."actorId",a."guildId",a."aggregateId",c."commandKind",c."actorId" AS "receiptActor",
              (SELECT count(*)::int FROM "OutboxEvent" o WHERE o."eventId"=a."id") AS "outbox"
       FROM "AuditEvent" a JOIN "CommandReceipt" c ON c."id"=a."receiptId"`,
    )) as Record<string, unknown>[];
    expect(audit).toEqual([
      {
        eventType: 'guild.activated.v1',
        actorId: operator.accountId,
        guildId: view.guild.id,
        aggregateId: view.guild.id,
        commandKind: 'ActivateGuild',
        receiptActor: operator.accountId,
        outbox: 0,
      },
    ]);
  });

  it('never lets an applicant approve their own Guild, including an applicant who is allowlisted', async () => {
    const applicant = await person();
    const draft = await draftOf(applicant, 'self-guild');
    // The applicant is the only listed operator, the flag is on, and they hold a live session.
    open(applicant);
    const response = await activate(applicant, draft);
    expect(response.status).toBe(403);
    expect((await json(response)).error.code).toBe('FORBIDDEN');
    expect(await guildCount()).toBe(0);
    expect(await count('AuditEvent')).toBe(0);
    expect(await count('GuildProfileVersion')).toBe(0);
    // Not even one of several operators: the same account stays refused, and a different operator succeeds.
    const operator = await person();
    open(applicant, operator);
    expect((await activate(applicant, draft, 'ev-2', 'key-self-again')).status).toBe(403);
    expect(await guildCount()).toBe(0);
    expect((await activate(operator, draft, 'ev-3', 'key-other')).status).toBe(200);
    expect(await guildCount()).toBe(1);
  });

  it('refuses an account that is not on the activation allowlist, including a work operator', async () => {
    const applicant = await person();
    const stranger = await person();
    const workOperator = await person();
    const operator = await person();
    const draft = await draftOf(applicant, 'closed-guild');
    open(operator);
    vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', workOperator.accountId);
    for (const who of [stranger, workOperator]) {
      const response = await activate(who, draft, 'ev-1', 'key-' + who.accountId);
      expect(response.status).toBe(403);
      expect((await json(response)).error.code).toBe('FORBIDDEN');
    }
    expect(await guildCount()).toBe(0);
    expect(await count('AuditEvent')).toBe(0);
  });

  it('stays closed with the switch off or the allowlist empty, writing nothing', async () => {
    const applicant = await person();
    const operator = await person();
    const draft = await draftOf(applicant, 'off-guild');
    vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', operator.accountId);
    const off = await activate(operator, draft, 'ev-1', 'key-off');
    expect(off.status).toBe(503);
    expect((await json(off)).error.code).toBe('NOT_AVAILABLE');
    vi.stubEnv('GUILD_ACTIVATION_ENABLED', 'true');
    vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', '');
    expect((await activate(operator, draft, 'ev-1', 'key-empty')).status).toBe(403);
    expect(await guildCount()).toBe(0);
    expect(await count('CommandReceipt')).toBe(1 /* the applicant's draft */);
    expect(await count('AuditEvent')).toBe(1 /* the draft's own audit event */);
  });

  it('replays an original activation with the switch off, but only for an operator who is still listed', async () => {
    const applicant = await person();
    const operator = await person();
    const draft = await draftOf(applicant, 'replay-guild');
    open(operator);
    const first = await activate(operator, draft, 'ev-1', 'key-replay');
    expect(first.status).toBe(200);
    vi.stubEnv('GUILD_ACTIVATION_ENABLED', 'false');
    const replay = await activate(operator, draft, 'ev-1', 'key-replay');
    expect(replay.status).toBe(200);
    expect((await json(replay)).status).toBe('REPLAYED');
    vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', 'someone-else');
    expect((await activate(operator, draft, 'ev-1', 'key-replay')).status).toBe(403);
    expect(await guildCount()).toBe(1);
  });

  it('refuses a stale draft revision, a second activation of one draft and a suspended operator', async () => {
    const applicant = await person();
    const operator = await person();
    const draft = await draftOf(applicant, 'conflict-guild');
    open(operator);
    expect(
      (await activate(operator, { id: draft.id, revision: draft.revision + 1 }, 'ev-1', 'k-stale'))
        .status,
    ).toBe(409);
    expect((await activate(operator, draft, 'ev-1', 'k-first')).status).toBe(200);
    expect((await activate(operator, draft, 'ev-2', 'k-second')).status).toBe(503);
    expect(await guildCount()).toBe(1);
    const other = await draftOf(await person(), 'suspended-guild');
    await db.user.update({ where: { id: operator.accountId }, data: { suspended: true } });
    const blocked = await activate(operator, other, 'ev-3', 'k-suspended');
    expect(blocked.status).toBe(403);
    expect((await json(blocked)).error.code).toBe('ACCOUNT_RESTRICTED');
    expect(await guildCount()).toBe(1);
  });
});
