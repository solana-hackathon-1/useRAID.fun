import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { hash } from '../src/lib/auth-primitives';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import {
  readSkillTaxonomyForPublisher,
  publishSkillTaxonomy,
} from '../src/skills/taxonomy-storage';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('current locked taxonomy editor read', () => {
  let actor: { accountId: string; sessionHash: string };
  let allowed: boolean;
  const policy = { canPublish: () => allowed };
  const id = 'synthetic-editor';
  const read = () =>
    runCommandTransaction(db, (tx) => readSkillTaxonomyForPublisher(tx, actor, id, policy));
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    allowed = true;
    const user = await db.user.create({
      data: { handle: 'synthetic-editor', role: 'ADMIN', xId: 'synthetic-current-x' },
    });
    actor = { accountId: user.id, sessionHash: hash(randomUUID()) };
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: actor.sessionHash,
        via: 'x',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
  });
  afterAll(() => db.$disconnect());
  it('returns actual empty publisher catalog without creating version/receipt/audit', async () => {
    expect(await read()).toBeNull();
    expect(await db.commandReceipt.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(0);
  });
  it('returns the actual immutable published version under current scoped publisher authority', async () => {
    const value = await runCommandTransaction(db, (tx) =>
      publishSkillTaxonomy(
        tx,
        {
          actor,
          input: {
            taxonomyId: id,
            expectedRevision: 0,
            skills: [
              {
                id: 'frontend',
                domain: 'software.frontend',
                name: 'Frontend',
                status: 'ACTIVE',
                aliases: ['frontend'],
              },
            ],
          },
          idempotencyKey: randomUUID(),
          requestId: 'synthetic-editor',
        },
        { allowNewWrites: true, ...policy },
      ),
    );
    expect(await read()).toEqual(value.taxonomy);
    expect(await db.commandReceipt.count()).toBe(1);
  });
  it('denies current allowlist removal even for absent catalogs', async () => {
    allowed = false;
    await expect(read()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('denies wallet-only admin sessions despite their connected X identity', async () => {
    await db.session.update({ where: { tokenHash: actor.sessionHash }, data: { via: 'wallet' } });
    await expect(read()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('denies revoked own sessions before returning even an empty editor state', async () => {
    await db.session.delete({ where: { tokenHash: actor.sessionHash } });
    await expect(read()).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });
  it('rechecks scoped policy after reading under the locked account facts', async () => {
    let calls = 0;
    await expect(
      runCommandTransaction(db, (tx) =>
        readSkillTaxonomyForPublisher(tx, actor, id, {
          canPublish: (locked) => {
            expect(locked).toEqual({ accountId: actor.accountId, xId: 'synthetic-current-x' });
            expect(Object.isFrozen(locked)).toBe(true);
            return ++calls === 1;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toBe(2);
    expect(await db.commandReceipt.count()).toBe(0);
  });
});
