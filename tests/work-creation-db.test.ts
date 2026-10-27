import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { saveRaidTerms, publishRaid } from '../src/work-loop/storage';
import { readCreationDrafts } from '../src/work-loop/creation-storage';
import { createSimulatedReservations } from '../src/work-loop/simulated-reservation';
import type { WorkHost } from '../src/work-loop/contracts';
import { AssetPolicySnapshotSchema } from '../src/contracts/assets';
import type { RewardAsset } from '../src/work-loop/creation-form';
import { canonicalRequestDigest } from '../src/command-receipts';
import { RaidTermsSchema } from '../src/work-loop/terms';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const sol = AssetPolicySnapshotSchema.parse(raidTerms().rewards[0].policy);
const token = AssetPolicySnapshotSchema.parse({
  ...sol,
  assetId: {
    chain: 'SOLANA',
    networkIdentity: 'synthetic-work',
    kind: 'TOKEN',
    mint: '11111111111111111111111111111111',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  },
  verifiedDecimals: 6,
});
const assets = (tokenFunded: boolean): RewardAsset[] => [
  { label: 'Synthetic SOL', policy: sol, funded: true },
  { label: 'Synthetic token', policy: token, funded: tokenFunded },
];
const twoAssets = () => ({
  ...raidTerms(),
  rewards: [
    { policy: sol, amount: '1500000000' },
    { policy: token, amount: '2500000' },
  ],
});
const hostFor = (founderId: string, catalog: RewardAsset[]): WorkHost => ({
  allowNewWrites: true,
  authorize: async (_tx, a, g) => a.accountId === founderId && g === 'synthetic-guild',
  reserveSimulatedFunding: createSimulatedReservations(catalog),
});
const cmd = (actor: { accountId: string; sessionHash: string }, input: unknown) => ({
  actor,
  input,
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
});
async function founder() {
  return seedWorkHuman(db, 'founder-' + randomUUID());
}
const save = (f: Awaited<ReturnType<typeof founder>>, h: WorkHost, terms: unknown) =>
  run((tx) =>
    saveRaidTerms(
      tx,
      cmd(f.actor, { listingId: null, expectedRevision: 0, guildId: 'synthetic-guild', terms }),
      h,
    ),
  );
const publish = (
  f: Awaited<ReturnType<typeof founder>>,
  h: WorkHost,
  saved: { listingId: string; termsVersionId: string },
) =>
  run((tx) =>
    publishRaid(
      tx,
      cmd(f.actor, { listingId: saved.listingId, termsVersionId: saved.termsVersionId }),
      h,
    ),
  );
const row = async <T>(sql: string, ...args: string[]) =>
  (await db.$queryRawUnsafe(sql, ...args)) as T[];
integration('T018 founder creation drafts and simulated reward reservation', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('lists only the Founder’s own authorized drafts with server-derived publication state', async () => {
    const mine = await founder();
    const other = await founder();
    const host = hostFor(mine.actor.accountId, assets(true));
    const saved = await save(mine, host, raidTerms());
    await save(other, hostFor(other.actor.accountId, assets(true)), raidTerms());
    const drafts = await run((tx) => readCreationDrafts(tx, mine.actor, host));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      listingId: saved.listingId,
      termsVersionId: saved.termsVersionId,
      revision: 1,
      state: 'DRAFT',
      reserved: false,
      problems: [],
    });
    expect(drafts[0].terms.title).toBe(raidTerms().title);
    // The host denying Guild authority hides the draft; a stranger sees nothing.
    expect(
      await run((tx) =>
        readCreationDrafts(tx, mine.actor, { ...host, authorize: async () => false }),
      ),
    ).toEqual([]);
    const stranger = await seedWorkHuman(db);
    expect(await run((tx) => readCreationDrafts(tx, stranger.actor, host))).toEqual([]);
    // A deadline that has passed is a server-derived problem, not left to the browser.
    const late = await save(mine, host, {
      ...raidTerms(),
      deadlines: {
        ...raidTerms().deadlines,
        commitment: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const listed = await run((tx) => readCreationDrafts(tx, mine.actor, host));
    expect(listed.find((d) => d.listingId === late.listingId)?.problems).toContain(
      'DEADLINE_PASSED',
    );
  });
  it('reads an exact old receipt version outside the recent list without substituting current terms', async () => {
    const f = await founder();
    const host = hostFor(f.actor.accountId, assets(true));
    const first = await save(f, host, raidTerms());
    await run((tx) =>
      saveRaidTerms(
        tx,
        cmd(f.actor, {
          listingId: first.listingId,
          expectedRevision: 1,
          guildId: 'synthetic-guild',
          terms: { ...raidTerms(), title: 'Newer version' },
        }),
        host,
      ),
    );
    for (let i = 0; i < 20; i++) await save(f, host, raidTerms());
    const exact = await run((tx) =>
      readCreationDrafts(tx, f.actor, host, {
        listingId: first.listingId,
        termsVersionId: first.termsVersionId,
      }),
    );
    expect(exact).toHaveLength(1);
    expect(exact[0]).toMatchObject({
      listingId: first.listingId,
      termsVersionId: first.termsVersionId,
      revision: 1,
      terms: { title: raidTerms().title },
      problems: ['TERMS_VERSION_CHANGED'],
    });
  });
  it('never makes a partly funded reward eligible: one funded asset out of two blocks publication and keeps the draft', async () => {
    const f = await founder();
    const partial = hostFor(f.actor.accountId, assets(false));
    const saved = await save(f, partial, twoAssets());
    await expect(publish(f, partial, saved)).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    expect(await row('SELECT 1 FROM "RaidSlot"')).toEqual([]);
    expect(await row('SELECT 1 FROM "WorkSimulatedReservation"')).toEqual([]);
    const [listing] = await row<{ state: string; revision: number }>(
      'SELECT "state","revision" FROM "WorkListing"',
    );
    expect(listing).toEqual({ state: 'DRAFT', revision: 1 });
    // The draft survives the failure unchanged and can be published once every leg is covered.
    const drafts = await run((tx) => readCreationDrafts(tx, f.actor, partial));
    expect(drafts[0]).toMatchObject({ state: 'DRAFT', reserved: false, revision: 1 });
    const full = hostFor(f.actor.accountId, assets(true));
    const published = await publish(f, full, saved);
    expect(published.fundingMode).toBe('SIMULATED');
    const [reservation] = await row<{ slotId: string; legs: { amount: string }[] }>(
      'SELECT "slotId"::text,"legs" FROM "WorkSimulatedReservation"',
    );
    expect(reservation.slotId).toBe(published.slotId);
    expect(reservation.legs.map((l) => l.amount)).toEqual(['1500000000', '2500000']);
    const [bound] = await row<{ vectorDigest: string }>(
      'SELECT "vectorDigest" FROM "WorkSimulatedReservation"',
    );
    expect(bound.vectorDigest).toBe(
      canonicalRequestDigest(RaidTermsSchema.parse(twoAssets()).rewards),
    );
    const [slot] = await row<{ fundingRef: string }>('SELECT "fundingRef" FROM "RaidSlot"');
    expect(slot.fundingRef).toBe('sim-reservation:' + published.slotId);
    const after = await run((tx) => readCreationDrafts(tx, f.actor, full));
    expect(after[0]).toMatchObject({ state: 'OPEN', reserved: true });
  });
  it('refuses a reward whose policy is not the catalog’s exact policy or that repeats an asset', async () => {
    const f = await founder();
    const host = hostFor(f.actor.accountId, assets(true));
    const forged = AssetPolicySnapshotSchema.parse({
      ...sol,
      verifiedDecimals: 0,
      registryVersion: 'forged-registry',
      observedAuthorities: [],
    });
    for (const rewards of [
      [{ policy: forged, amount: '18446744073709551615' }],
      [
        { policy: sol, amount: '1' },
        { policy: sol, amount: '2' },
      ],
    ]) {
      const saved = await save(f, host, { ...raidTerms(), rewards });
      await expect(publish(f, host, saved)).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    }
    expect(await row('SELECT 1 FROM "RaidSlot"')).toEqual([]);
    expect(await row('SELECT 1 FROM "WorkSimulatedReservation"')).toEqual([]);
  });
  it('conceals absent and foreign publication targets and never reopens terminal or paused listings', async () => {
    const f = await founder();
    const other = await founder();
    const host = hostFor(f.actor.accountId, assets(true));
    const foreign = await save(other, hostFor(other.actor.accountId, assets(true)), raidTerms());
    for (const target of [foreign, { listingId: randomUUID(), termsVersionId: randomUUID() }]) {
      await expect(publish(f, host, target)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
  it('never reopens a terminal or paused listing through publication', async () => {
    const f = await founder();
    const host = hostFor(f.actor.accountId, assets(true));
    for (const state of ['PAUSED', 'CLOSED', 'CANCELLED', 'ARCHIVED']) {
      const saved = await save(f, host, raidTerms());
      await db.$executeRawUnsafe(
        'UPDATE "WorkListing" SET "state"=$2 WHERE "id"=$1::uuid',
        saved.listingId,
        state,
      );
      await expect(publish(f, host, saved)).rejects.toMatchObject({ code: 'PUBLICATION_BLOCKED' });
    }
    expect(await row('SELECT 1 FROM "RaidSlot"')).toEqual([]);
  });
  it('records a replaceable host funding reference in the canonical reservation', async () => {
    const f = await founder();
    const host = {
      ...hostFor(f.actor.accountId, assets(true)),
      reserveSimulatedFunding: async () => 'alternate-reserve:exact-vector',
    };
    const saved = await save(f, host, twoAssets());
    const result = await publish(f, host, saved);
    expect(
      await row(
        'SELECT "fundingRef","termsVersionId"::text,"vectorDigest","legs" FROM "WorkSimulatedReservation" WHERE "slotId"=$1::uuid',
        result.slotId,
      ),
    ).toEqual([
      {
        fundingRef: 'alternate-reserve:exact-vector',
        termsVersionId: saved.termsVersionId,
        vectorDigest: canonicalRequestDigest(RaidTermsSchema.parse(twoAssets()).rewards),
        legs: RaidTermsSchema.parse(twoAssets()).rewards,
      },
    ]);
  });
  it('rejects direct SQL publication without an exact reservation binding at commit', async () => {
    const f = await founder();
    const saved = await save(f, hostFor(f.actor.accountId, assets(true)), raidTerms());
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO "RaidSlot" ("listingId","termsVersionId","slotNumber","fundingRef") VALUES ($1::uuid,$2::uuid,1,$3)',
          saved.listingId,
          saved.termsVersionId,
          'forged-ref',
        );
        await tx.$executeRawUnsafe(
          'UPDATE "WorkListing" SET "state"=\'OPEN\' WHERE "id"=$1::uuid',
          saved.listingId,
        );
      }),
    ).rejects.toThrow(/reservation binding/);
    expect(await row('SELECT 1 FROM "RaidSlot"')).toEqual([]);
  });
  it.each(['reference', 'reward-vector', 'digest'] as const)(
    'rejects a direct SQL reservation with the wrong %s',
    async (mismatch) => {
      const f = await founder();
      const saved = await save(f, hostFor(f.actor.accountId, assets(true)), raidTerms());
      const slotId = randomUUID();
      const legs = RaidTermsSchema.parse(raidTerms()).rewards;
      const wrongLegs = legs.map((leg) => ({ ...leg, amount: '2' }));
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'INSERT INTO "RaidSlot" ("id","listingId","termsVersionId","slotNumber","fundingRef") VALUES ($1::uuid,$2::uuid,$3::uuid,1,$4)',
            slotId,
            saved.listingId,
            saved.termsVersionId,
            'reserve:' + slotId,
          );
          const vector = mismatch === 'reward-vector' ? wrongLegs : legs;
          await tx.$executeRawUnsafe(
            'INSERT INTO "WorkSimulatedReservation" ("slotId","termsVersionId","fundingRef","vectorDigest","legs") VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb)',
            slotId,
            saved.termsVersionId,
            mismatch === 'reference' ? 'wrong-reference' : 'reserve:' + slotId,
            mismatch === 'digest' ? 'a'.repeat(64) : canonicalRequestDigest(vector),
            JSON.stringify(vector),
          );
        }),
      ).rejects.toThrow(
        mismatch === 'digest'
          ? /WorkSimulatedReservation_exactVector_check/
          : /Exact reservation binding required/,
      );
      expect(await row('SELECT 1 FROM "RaidSlot"')).toEqual([]);
    },
  );
  it('rejects a duplicate or invalid catalog at the reusable reservation factory', async () => {
    const f = await founder();
    for (const catalog of [
      [assets(true)[0], assets(true)[0]],
      [{ ...assets(true)[0], policy: { ...sol, verifiedDecimals: Number.NaN } }],
    ]) {
      const host = hostFor(f.actor.accountId, catalog as RewardAsset[]);
      const saved = await save(f, host, raidTerms());
      await expect(publish(f, host, saved)).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    }
    expect(await row('SELECT 1 FROM "WorkSimulatedReservation"')).toEqual([]);
  });
  it('records one immutable reservation per slot bound to the exact reward vector', async () => {
    const f = await founder();
    const host = hostFor(f.actor.accountId, assets(true));
    const saved = await save(f, host, twoAssets());
    const published = await publish(f, host, saved);
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "WorkSimulatedReservation" SET "vectorDigest"='${'a'.repeat(64)}'`,
      ),
    ).rejects.toThrow(/immutable/);
    await expect(db.$executeRawUnsafe('DELETE FROM "WorkSimulatedReservation"')).rejects.toThrow(
      /immutable/,
    );
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "WorkSimulatedReservation" ("slotId","termsVersionId","vectorDigest","legs") SELECT "id","termsVersionId",'${'b'.repeat(64)}','[]'::jsonb FROM "RaidSlot" WHERE "id"=$1::uuid`,
        published.slotId,
      ),
    ).rejects.toThrow();
    // The record preserves the host's decision; deferred guards bind its exact reference and vector to the slot.
    expect(
      (await row<{ n: number }>('SELECT count(*)::int AS n FROM "WorkSimulatedReservation"'))[0].n,
    ).toBe(1);
  });
});

integration('T018 additive reservation migration on existing history', () => {
  it.each(['valid', 'missing-record', 'wrong-reference', 'wrong-vector', 'wrong-digest'] as const)(
    'preserves genuine evidence and rejects %s history without manufacturing coverage',
    async (kind) => {
      assertTestDatabase();
      const name = 'useraid_test_upgrade_' + randomUUID().replaceAll('-', '');
      const directory = mkdtempSync(join(tmpdir(), 'raid-246-upgrade-'));
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = '/' + name;
      const database = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      const migration = '202610270001_work_reservation_binding';
      try {
        await db.$executeRawUnsafe('CREATE DATABASE "' + name + '"');
        cpSync('prisma', join(directory, 'prisma'), {
          recursive: true,
          filter: (path) => !path.includes(migration),
        });
        const deploy = () =>
          spawnSync(
            'node_modules/.bin/prisma',
            ['migrate', 'deploy', '--schema', join(directory, 'prisma/schema.prisma')],
            { env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8' },
          );
        const before = deploy();
        expect(before.status, before.stdout + before.stderr).toBe(0);
        const f = await seedWorkHuman(database);
        const host = hostFor(f.actor.accountId, assets(true));
        const saved = await runCommandTransaction(database, (tx) =>
          saveRaidTerms(
            tx,
            cmd(f.actor, {
              listingId: null,
              expectedRevision: 0,
              guildId: 'synthetic-guild',
              terms: raidTerms(),
            }),
            host,
          ),
        );
        const slotId = randomUUID();
        const reference =
          kind === 'wrong-reference' ? 'unproven-reference' : 'sim-reservation:' + slotId;
        const vector = RaidTermsSchema.parse(raidTerms()).rewards.map((leg) => ({
          ...leg,
          amount: kind === 'wrong-vector' ? '2' : leg.amount,
        }));
        await database.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'INSERT INTO "RaidSlot" ("id","listingId","termsVersionId","slotNumber","fundingRef") VALUES ($1::uuid,$2::uuid,$3::uuid,1,$4)',
            slotId,
            saved.listingId,
            saved.termsVersionId,
            reference,
          );
          if (kind !== 'missing-record')
            await tx.$executeRawUnsafe(
              'INSERT INTO "WorkSimulatedReservation" ("slotId","termsVersionId","vectorDigest","legs") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb)',
              slotId,
              saved.termsVersionId,
              kind === 'wrong-digest' ? 'a'.repeat(64) : canonicalRequestDigest(vector),
              JSON.stringify(vector),
            );
          await tx.$executeRawUnsafe(
            'UPDATE "WorkListing" SET "state"=\'OPEN\' WHERE "id"=$1::uuid',
            saved.listingId,
          );
        });
        cpSync(
          join('prisma/migrations', migration),
          join(directory, 'prisma/migrations', migration),
          { recursive: true },
        );
        const after = deploy();
        if (kind === 'valid') {
          expect(after.status, after.stdout + after.stderr).toBe(0);
          expect(
            await database.$queryRawUnsafe('SELECT "fundingRef" FROM "WorkSimulatedReservation"'),
          ).toEqual([{ fundingRef: reference }]);
        } else {
          expect(after.status).not.toBe(0);
          expect(
            await database.$queryRawUnsafe(
              "SELECT 1 FROM information_schema.columns WHERE table_name='WorkSimulatedReservation' AND column_name='fundingRef'",
            ),
          ).toEqual([]);
        }
        expect(
          await database.$queryRawUnsafe('SELECT "legs" FROM "WorkSimulatedReservation"'),
        ).toEqual(kind === 'missing-record' ? [] : [{ legs: vector }]);
        expect(await database.$queryRawUnsafe('SELECT "fundingRef" FROM "RaidSlot"')).toEqual([
          { fundingRef: reference },
        ]);
      } finally {
        await database.$disconnect();
        await db.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + name + '"');
        rmSync(directory, { recursive: true, force: true });
      }
    },
    60000,
  );
});
