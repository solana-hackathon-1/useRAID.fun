import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveRaidTerms, publishRaid, readRaidTerms } from '../src/work-loop/storage';
import type { WorkHost, WorkActor } from '../src/work-loop/contracts';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { raidTerms } from './helpers/raid-terms-fixture';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const owner: WorkActor = { accountId: 'synthetic-founder', sessionHash: 'a'.repeat(64) };
const stranger: WorkActor = { accountId: 'stranger', sessionHash: 'b'.repeat(64) };
const host: WorkHost = {
  allowNewWrites: true,
  authorize: async (_tx, actor, guild) =>
    actor.accountId === owner.accountId &&
    actor.sessionHash === owner.sessionHash &&
    guild === 'synthetic-guild',
  reserveSimulatedFunding: async (_tx, b) => 'synthetic:' + b.slotId,
};
const command = (input: unknown, key: string = randomUUID(), actor = owner) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: 'test:' + key,
});
const save = (input: unknown, key?: string, actor = owner, h = host) =>
  runCommandTransaction(db, (tx) => saveRaidTerms(tx, command(input, key, actor), h));
const draft = () => ({
  listingId: null,
  expectedRevision: 0,
  guildId: 'synthetic-guild',
  terms: raidTerms(),
});
const publish = (id: string, version: string, h = host, key?: string) =>
  runCommandTransaction(db, (tx) =>
    publishRaid(tx, command({ listingId: id, termsVersionId: version }, key), h),
  );
const query = async (sql: string, ...args: string[]) =>
  db.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...args);
integration('T016 durable immutable terms and publication', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    await db.user.create({ data: { id: owner.accountId, handle: 'synthetic-founder' } });
  });
  afterAll(() => db.$disconnect());
  it('persists complete immutable versions separately from legacy Raid records', async () => {
    const result = await save(draft());
    expect(result.status).toBe('EXECUTED');
    expect(result.terms).toEqual(raidTerms());
    const [row] = await query(
      'SELECT "revision","state" FROM "WorkListing" WHERE "id"=$1::uuid',
      result.listingId,
    );
    expect(row).toEqual({ revision: 1, state: 'DRAFT' });
    expect(await db.raid.count()).toBe(0);
    expect(await db.auditEvent.count()).toBe(1);
    expect(await db.outboxEvent.count()).toBe(1);
  });
  it('rejects raw SQL rewrites and deletion of old terms', async () => {
    const one = await save(draft());
    const two = await save({
      ...draft(),
      listingId: one.listingId,
      expectedRevision: 1,
      terms: { ...raidTerms(), outcome: 'A changed unaccepted draft' },
    });
    expect(two.revision).toBe(2);
    expect(
      await runCommandTransaction(db, (tx) => readRaidTerms(tx, owner, one.termsVersionId, host)),
    ).toMatchObject({ terms: raidTerms() });
    await expect(
      query(
        'UPDATE "TermsVersion" SET "snapshot"=$2::jsonb WHERE "id"=$1::uuid',
        one.termsVersionId,
        JSON.stringify(two.terms),
      ),
    ).rejects.toThrow();
    await expect(
      query('DELETE FROM "TermsVersion" WHERE "id"=$1::uuid', one.termsVersionId),
    ).rejects.toThrow();
  });
  it('rejects malformed base units inserted directly into the database', async () => {
    const one = await save(draft());
    for (const amount of ['1.5', '-1', '18446744073709551616']) {
      const invalid = raidTerms();
      invalid.rewards[0].amount = amount;
      await expect(
        query(
          'INSERT INTO "TermsVersion" ("listingId","revision","snapshot","digest") VALUES ($1::uuid,2,$2::jsonb,$3) RETURNING "id"',
          one.listingId,
          JSON.stringify(invalid),
          '0'.repeat(64),
        ),
      ).rejects.toThrow();
    }
  });
  it('denies foreign, missing scoped authority and disabled new writes, without receipts or data', async () => {
    await expect(save(draft(), undefined, stranger)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(save({ ...draft(), guildId: 'other-guild' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      save(draft(), undefined, owner, { ...host, allowNewWrites: false }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(await db.commandReceipt.count()).toBe(0);
  });
  it('keeps original receipt replay when new writes are off and rejects changed payload', async () => {
    const input = draft(),
      key = randomUUID(),
      one = await save(input, key);
    expect(await save(input, key, owner, { ...host, allowNewWrites: false })).toEqual({
      ...one,
      status: 'REPLAYED',
    });
    await expect(
      save({ ...input, terms: { ...input.terms, title: 'Different intent' } }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      save(input, key, owner, { ...host, authorize: async () => false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('publishes only current complete future terms with an exact simulated slot reservation', async () => {
    const one = await save(draft());
    await expect(
      publish(one.listingId, one.termsVersionId, {
        ...host,
        reserveSimulatedFunding: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    expect(await query('SELECT * FROM "RaidSlot"')).toHaveLength(0);
    const published = await publish(one.listingId, one.termsVersionId);
    const [slot] = await query(
      'SELECT "termsVersionId"::text,"state","fundingMode","fundingRef" FROM "RaidSlot" WHERE "id"=$1::uuid',
      published.slotId,
    );
    expect(slot).toMatchObject({
      termsVersionId: one.termsVersionId,
      state: 'AVAILABLE',
      fundingMode: 'SIMULATED',
      fundingRef: 'synthetic:' + published.slotId,
    });
  });
  it('rejects an OPEN listing without a funded current slot at commit', async () => {
    const one = await save(draft());
    await expect(
      query(
        'UPDATE "WorkListing" SET "state"=\'OPEN\' WHERE "id"=$1::uuid RETURNING "id"',
        one.listingId,
      ),
    ).rejects.toThrow();
  });
  it('rejects stale terms and stale revisions without overwriting history', async () => {
    const one = await save(draft());
    await save({ ...draft(), listingId: one.listingId, expectedRevision: 1 });
    await expect(publish(one.listingId, one.termsVersionId)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    await expect(
      save({ ...draft(), listingId: one.listingId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
  it('creates a fresh slot on pre-acceptance amendment and closes the old offer target', async () => {
    const one = await save(draft()),
      published = await publish(one.listingId, one.termsVersionId);
    const two = await save({ ...draft(), listingId: one.listingId, expectedRevision: 1 });
    expect(
      await query('SELECT "state" FROM "RaidSlot" WHERE "id"=$1::uuid', published.slotId),
    ).toEqual([{ state: 'CLOSED' }]);
    const newPublication = await publish(two.listingId, two.termsVersionId);
    expect(newPublication.slotId).not.toBe(published.slotId);
  });
  it('freezes versions after source assignment and rejects privileged raw mutation', async () => {
    const one = await save(draft()),
      published = await publish(one.listingId, one.termsVersionId);
    await query(
      'UPDATE "RaidSlot" SET "state"=\'FILLED\' WHERE "id"=$1::uuid RETURNING "id"',
      published.slotId,
    );
    await expect(
      save({ ...draft(), listingId: one.listingId, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'TERMS_FROZEN' });
    await expect(
      query(
        'UPDATE "RaidSlot" SET "termsVersionId"=$2::uuid WHERE "id"=$1::uuid',
        published.slotId,
        randomUUID(),
      ),
    ).rejects.toThrow();
  });
  it('prevents publication of expired or unsupported terms even with owner authority', async () => {
    const one = await save({
      ...draft(),
      terms: {
        ...raidTerms(),
        deadlines: {
          commitment: '2020-01-01T00:00:00.000Z',
          preparation: '2020-01-02T00:00:00.000Z',
          submission: '2020-01-03T00:00:00.000Z',
          review: '2020-01-04T00:00:00.000Z',
          operationalClosure: '2020-01-05T00:00:00.000Z',
        },
      },
    });
    await expect(publish(one.listingId, one.termsVersionId)).rejects.toMatchObject({
      code: 'PUBLICATION_BLOCKED',
    });
  });
});
