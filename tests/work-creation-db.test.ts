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
    // Direct SQL cannot give an OPEN slot a reservation reference for a different vector.
    expect(
      (await row<{ n: number }>('SELECT count(*)::int AS n FROM "WorkSimulatedReservation"'))[0].n,
    ).toBe(1);
  });
});
