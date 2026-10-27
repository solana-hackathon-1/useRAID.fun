import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { canonicalRequestDigest } from '../src/command-receipts';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { recordAcceptanceConsent } from '../src/work-loop/consent-storage';
import { createRootAcceptanceHost } from '../src/lib/work-acceptance-host';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot } from './helpers/work-loop-db';
import { seedOwnAssessmentFixture, db } from './helpers/own-assessment-fixture';
import { assertTestDatabase } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
type Actor = { accountId: string; sessionHash: string };
const cmd = (actor: Actor, input: unknown, key: string = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: key,
});
const TAXONOMY = 'synthetic-submission-catalog';
const host = (overrides: Record<string, unknown> = {}) =>
  createRootAcceptanceHost({
    taxonomyId: TAXONOMY,
    allowNewWrites: true,
    isOperator: () => false,
    ...overrides,
  });
let person: Actor;
let policyVersionId: string;
async function setup() {
  const fx = await seedOwnAssessmentFixture(true);
  person = { accountId: fx.ownerId, sessionHash: fx.cookieHash };
  const [row] = (await db.$queryRawUnsafe(
    'SELECT "policyVersionId"::text AS id FROM "SkillAssessmentVersion" LIMIT 1',
  )) as { id: string }[];
  policyVersionId = row.id;
  return fx;
}
const skill = (minimumRank: string, policy = () => policyVersionId) => ({
  skillId: 'frontend',
  minimumRank,
  assessmentPolicyVersion: policy(),
});
async function raid(minimumRank = 'D', policy?: string) {
  const slot = await seedWorkSlot(db as never, undefined, {
    requiredSkills: [skill(minimumRank, () => policy ?? policyVersionId)] as never,
  });
  const terms = (
    (await db.$queryRawUnsafe(
      'SELECT "digest" FROM "TermsVersion" WHERE "id"=$1::uuid',
      slot.termsVersionId,
    )) as {
      digest: string;
    }[]
  )[0];
  return { slot, digest: terms.digest };
}
const consent = (actor: Actor, slot: { slotId: string; termsVersionId: string }, digest: string) =>
  run((tx) =>
    recordAcceptanceConsent(
      tx,
      cmd(actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId, termsDigest: digest }),
      { allowNewWrites: true },
    ),
  );
const accept = (actor: Actor, slot: { slotId: string; termsVersionId: string }, h = host()) =>
  run((tx) =>
    commitEngagement(
      tx,
      cmd(actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      h,
    ),
  );
integration('Root acceptance: explicit consent and verified skills', { timeout: 120000 }, () => {
  beforeEach(() => assertTestDatabase());
  afterAll(() => db.$disconnect());
  it('accepts only with the person’s consent to the exact terms and a verified skill that meets the requirement', async () => {
    await setup();
    const { slot, digest } = await raid('D');
    await expect(accept(person, slot)).rejects.toMatchObject({ code: 'ELIGIBILITY_REJECTED' });
    const saved = await consent(person, slot, digest);
    expect(saved.consent.termsDigest).toBe(digest);
    const accepted = await accept(person, slot);
    expect(accepted.engagement.state).toBe('ACCESS_PENDING');
    expect(accepted.engagement.acceptedTerms.roster[0].consentRef).toBe(saved.consent.id);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "ActiveCommitment"')).toHaveLength(1);
  });
  it('refuses a required rank above the verified one (A) even with consent', async () => {
    await setup();
    const tooHigh = await raid('S');
    await consent(person, tooHigh.slot, tooHigh.digest);
    await expect(accept(person, tooHigh.slot)).rejects.toMatchObject({
      code: 'ELIGIBILITY_REJECTED',
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "Engagement"')).toEqual([]);
  });
  it('refuses a changed assessment policy even with consent', async () => {
    await setup();
    const otherPolicy = await raid('D', 'some-other-policy');
    await consent(person, otherPolicy.slot, otherPolicy.digest);
    await expect(accept(person, otherPolicy.slot)).rejects.toMatchObject({
      code: 'ELIGIBILITY_REJECTED',
    });
  });
  it('refuses a revoked assessment even with consent', async () => {
    const fx = await setup();
    const fine = await raid('D');
    await consent(person, fine.slot, fine.digest);
    await fx.decide('REVOKE');
    await expect(accept(person, fine.slot)).rejects.toMatchObject({ code: 'ELIGIBILITY_REJECTED' });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "Engagement"')).toEqual([]);
  });
  it('binds consent to the person and the exact terms: another person, a wrong digest and a stale slot are refused', async () => {
    await setup();
    const { slot, digest } = await raid('D');
    await expect(consent(person, slot, 'a'.repeat(64))).rejects.toMatchObject({
      code: 'TERMS_VERSION_CHANGED',
    });
    await consent(person, slot, digest);
    const other = await seedWorkHuman(db as never);
    await expect(accept(other.actor, slot)).rejects.toMatchObject({ code: 'ELIGIBILITY_REJECTED' });
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "WorkAcceptanceConsent" ("participantId","slotId","termsVersionId","termsDigest") SELECT "id",$1::uuid,$2::uuid,$3 FROM "Participant" WHERE "accountId"=$4`,
        slot.slotId,
        slot.termsVersionId,
        'b'.repeat(64),
        other.actor.accountId,
      ),
    ).rejects.toThrow(/exact stored terms digest/);
    await expect(
      db.$executeRawUnsafe('UPDATE "WorkAcceptanceConsent" SET "termsDigest"=$1', 'c'.repeat(64)),
    ).rejects.toThrow(/immutable/);
    await expect(db.$executeRawUnsafe('DELETE FROM "WorkAcceptanceConsent"')).rejects.toThrow(
      /immutable/,
    );
    await accept(person, slot);
    await expect(consent(person, slot, digest)).rejects.toMatchObject({ code: 'SLOT_FILLED' });
  });
  it('replays a recorded consent and refuses new ones while writes are off', async () => {
    await setup();
    const { slot, digest } = await raid('D');
    const key = randomUUID();
    const input = { slotId: slot.slotId, termsVersionId: slot.termsVersionId, termsDigest: digest };
    const first = await run((tx) =>
      recordAcceptanceConsent(tx, cmd(person, input, key), { allowNewWrites: true }),
    );
    const again = await run((tx) =>
      recordAcceptanceConsent(tx, cmd(person, input, key), { allowNewWrites: false }),
    );
    expect(again.status).toBe('REPLAYED');
    expect(again.consent.id).toBe(first.consent.id);
    await expect(
      run((tx) => recordAcceptanceConsent(tx, cmd(person, input), { allowNewWrites: false })),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(canonicalRequestDigest(raidTerms())).toMatch(/^[0-9a-f]{64}$/);
  });
  it('waits on the assessment lock of each required skill, so a revocation in flight is never missed', async () => {
    await setup();
    const { slot, digest } = await raid('D');
    await consent(person, slot, digest);
    const [{ id: participantId }] = (await db.$queryRawUnsafe(
      'SELECT "id"::text FROM "Participant" WHERE "accountId"=$1',
      person.accountId,
    )) as { id: string }[];
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    // Stands in for a decision (REVOKE/REASSESS) that holds the same lock until it commits.
    const holder = db.$transaction(
      async (t) => {
        await t.$queryRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,12022))::text`,
          participantId + ':frontend',
        );
        locked();
        await released;
      },
      { timeout: 60000 },
    );
    try {
      await holding;
      let settled = false;
      const pending = accept(person, slot).finally(() => (settled = true));
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const rows = (await db.$queryRawUnsafe(
          `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND pid<>pg_backend_pid()`,
        )) as unknown[];
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      expect(settled).toBe(false);
      release();
      expect((await pending).engagement.state).toBe('ACCESS_PENDING');
    } finally {
      release();
      await holder;
    }
  });
});
