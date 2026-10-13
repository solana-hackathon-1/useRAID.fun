import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/lib/db';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import {
  listGuildDrafts,
  saveGuildDraft,
  type GuildDraftActor,
} from '../src/guild-profiles/draft-storage';
import { hash } from '../src/lib/auth-primitives';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
async function actor(): Promise<GuildDraftActor> {
  const u = await db.user.create({ data: { handle: 'synthetic-list-' + randomUUID() } }),
    sessionHash = hash(u.id);
  await db.session.create({
    data: {
      userId: u.id,
      tokenHash: sessionHash,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return { accountId: u.id, actorAccountId: u.id, sessionHash };
}
const list = (a: GuildDraftActor, input: unknown = { cursor: null, pageSize: 20 }) =>
  runCommandTransaction(db, (tx) => listGuildDrafts(tx, a, input));
const save = (a: GuildDraftActor, name: string, id: string | null = null, revision = 0) =>
  runCommandTransaction(db, (tx) =>
    saveGuildDraft(
      tx,
      {
        actor: a,
        input: {
          guildDraftId: id,
          expectedRevision: revision,
          profile: { name, slug: name.toLowerCase(), description: 'Private ' + name },
        },
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      },
      { allowNewWrites: true },
    ),
  );
integration('T009D1 private own bounded draft listing', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  it('returns a private empty page without creating command/audit rows', async () => {
    const a = await actor();
    expect(await list(a)).toEqual({ version: 'v1', drafts: [], nextCursor: null });
    expect(await db.commandReceipt.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
  });
  it('paginates current own versions in immutable creation order and never serializes another owner', async () => {
    const a = await actor(),
      b = await actor();
    const one = await save(a, 'Own-one'),
      two = await save(a, 'Own-two'),
      three = await save(a, 'Own-three');
    await save(b, 'Foreign-secret');
    const updated = await save(a, 'Own-one', one.draft.id, 1);
    const first = await list(a, { cursor: null, pageSize: 2 });
    expect(first).toEqual({
      version: 'v1',
      drafts: [three.draft, two.draft],
      nextCursor: two.draft.id,
    });
    const second = await list(a, { cursor: two.draft.id, pageSize: 2 });
    expect(second).toEqual({ version: 'v1', drafts: [updated.draft], nextCursor: null });
    expect(JSON.stringify([first, second])).not.toContain('Foreign-secret');
    expect(JSON.stringify(first)).not.toContain('sessionHash');
    expect(await db.commandReceipt.count()).toBe(5);
    expect(await db.auditEvent.count()).toBe(5);
    expect(await db.outboxEvent.count()).toBe(0);
  });
  it('keeps unrelated newest creations out of a continuation page and binds cursor to its own account', async () => {
    const a = await actor(),
      b = await actor();
    const old = await save(a, 'Old-own'),
      newer = await save(a, 'New-own');
    await save(a, 'Latest-own');
    expect(await list(a, { cursor: newer.draft.id, pageSize: 1 })).toEqual({
      version: 'v1',
      drafts: [old.draft],
      nextCursor: null,
    });
    for (const id of [old.draft.id, randomUUID()])
      await expect(list(b, { cursor: id, pageSize: 1 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
  });
  it('rejects unbounded/invalid inputs and forged identity rather than widening owner scope', async () => {
    const a = await actor(),
      b = await actor();
    for (const input of [
      { cursor: null, pageSize: 0 },
      { cursor: null, pageSize: 21 },
      { cursor: 'bad', pageSize: 1 },
      { cursor: null, pageSize: 1, accountId: b.accountId },
    ])
      await expect(list(a, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(list({ ...a, actorAccountId: b.accountId })).rejects.toMatchObject({
      code: 'WRONG_ACTOR',
    });
    await expect(list({ ...a, sessionHash: b.sessionHash })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
  it('requires a current unexpired own session and denies restricted owners', async () => {
    const a = await actor();
    await save(a, 'Owned');
    await db.session.update({
      where: { tokenHash: a.sessionHash },
      data: { expiresAt: new Date(0) },
    });
    await expect(list(a)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const b = await actor();
    await db.user.update({ where: { id: b.accountId }, data: { suspended: true } });
    await expect(list(b)).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
    expect(await db.commandReceipt.count()).toBe(1);
  });
});
