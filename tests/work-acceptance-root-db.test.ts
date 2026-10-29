import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { canonicalRequestDigest } from '../src/command-receipts';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { recordAcceptanceConsent } from '../src/work-loop/consent-storage';
import { issueOffer, submitApplication } from '../src/work-loop/admission-storage';
import type { AcceptanceHost } from '../src/work-loop/engagement-contracts';
import { createRootAcceptanceHost } from '../src/lib/work-acceptance-host';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot } from './helpers/work-loop-db';
import {
  seedOwnAssessmentFixture,
  publishSyntheticCatalog,
  db,
} from './helpers/own-assessment-fixture';
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
async function raid(
  minimumRank = 'D',
  policy?: string,
  override: Record<string, unknown> = {},
  founderId?: string,
) {
  const slot = await seedWorkSlot(db as never, founderId, {
    requiredSkills: [skill(minimumRank, () => policy ?? policyVersionId)] as never,
    ...override,
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
const accept = (
  actor: Actor,
  slot: { slotId: string; termsVersionId: string },
  h: AcceptanceHost = host(),
  offerId?: string,
) =>
  run((tx) =>
    commitEngagement(
      tx,
      cmd(actor, {
        slotId: slot.slotId,
        termsVersionId: slot.termsVersionId,
        ...(offerId ? { offerId } : {}),
      }),
      h,
    ),
  );
const advisoryWaiters = async () =>
  (
    (await db.$queryRawUnsafe(
      `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND pid<>pg_backend_pid()`,
    )) as unknown[]
  ).length;
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
integration('Root acceptance: explicit consent and verified skills', { timeout: 120000 }, () => {
  beforeEach(() => assertTestDatabase());
  afterAll(() => db.$disconnect());
  it('accepts only with the person’s consent to the exact terms and a verified skill that meets the requirement', async () => {
    await setup();
    const { slot, digest } = await raid('D');
    await expect(accept(person, slot)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    const saved = await consent(person, slot, digest);
    expect(saved.consent.termsDigest).toBe(digest);
    const accepted = await accept(person, slot);
    expect(accepted.engagement.state).toBe('ACCESS_PENDING');
    expect(accepted.engagement.acceptedTerms.roster[0].consentRef).toBe(saved.consent.id);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "ActiveCommitment"')).toHaveLength(1);
    expect(accepted.offerId).toBeNull();
  });
  it('admits an APPLICATION Raid through the Founder’s offer only while the issuer is an operator', async () => {
    await setup();
    const founder = await seedWorkHuman(db as never, 'founder-' + randomUUID());
    const { slot, digest } = await raid(
      'D',
      undefined,
      { admission: 'APPLICATION' },
      founder.actor.accountId,
    );
    const admission = {
      allowNewWrites: true,
      applicationLimit: 5,
      authorize: async (_tx: unknown, a: Actor) => a.accountId === founder.actor.accountId,
    };
    const application = await run((tx) =>
      submitApplication(
        tx,
        cmd(person, {
          slotId: slot.slotId,
          termsVersionId: slot.termsVersionId,
          evidenceRefs: ['synthetic:portfolio'],
        }),
        admission,
      ),
    );
    const offer = await run((tx) =>
      issueOffer(
        tx,
        cmd(founder.actor, {
          applicationId: application.application.id,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
        admission,
      ),
    );
    await consent(person, slot, digest);
    // Without the offer an APPLICATION Raid cannot be taken directly.
    await expect(accept(person, slot)).rejects.toMatchObject({ code: 'ADMISSION_REQUIRED' });
    // An issuer who is no longer an operator makes the offer unusable.
    await expect(accept(person, slot, host(), offer.offer.id)).rejects.toMatchObject({
      code: 'OFFER_UNAVAILABLE',
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "Engagement"')).toEqual([]);
    const operator = host({ isOperator: (id: string) => id === founder.actor.accountId });
    const accepted = await accept(person, slot, operator, offer.offer.id);
    expect(accepted.engagement.state).toBe('ACCESS_PENDING');
    expect(accepted.offerId).toBe(offer.offer.id);
    expect(await db.$queryRawUnsafe('SELECT "state" FROM "RaidOffer"')).toEqual([
      { state: 'ACCEPTED' },
    ]);
  });
  it('refuses with SLOT_FILLED, checked before the offer, when the slot is taken or the engagement is not bound to the requested offer', async () => {
    await setup();
    const founder = await seedWorkHuman(db as never, 'founder-' + randomUUID());
    const { slot, digest } = await raid(
      'D',
      undefined,
      { admission: 'APPLICATION' },
      founder.actor.accountId,
    );
    const admission = {
      allowNewWrites: true,
      applicationLimit: 5,
      authorize: async (_tx: unknown, a: Actor) => a.accountId === founder.actor.accountId,
    };
    const application = await run((tx) =>
      submitApplication(
        tx,
        cmd(person, {
          slotId: slot.slotId,
          termsVersionId: slot.termsVersionId,
          evidenceRefs: ['synthetic:portfolio'],
        }),
        admission,
      ),
    );
    const offer = await run((tx) =>
      issueOffer(
        tx,
        cmd(founder.actor, {
          applicationId: application.application.id,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
        admission,
      ),
    );
    await consent(person, slot, digest);
    const operator = host({ isOperator: (id: string) => id === founder.actor.accountId });
    const key = randomUUID();
    const request = {
      slotId: slot.slotId,
      termsVersionId: slot.termsVersionId,
      offerId: offer.offer.id,
    };
    await run((tx) => commitEngagement(tx, cmd(person, request, key), operator));
    // A new request for the filled slot is refused on the slot state, before any offer check.
    await expect(
      run((tx) => commitEngagement(tx, cmd(person, request), operator)),
    ).rejects.toMatchObject({ code: 'SLOT_FILLED' });
    // A replay whose engagement is no longer bound to the requested offer is a domain refusal, not a generic outage.
    await db.$transaction(async (t) => {
      await t.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await t.$executeRawUnsafe(
        `UPDATE "RaidOffer" SET "state"='REVOKED',"acceptedEngagementId"=NULL WHERE "id"=$1::uuid`,
        offer.offer.id,
      );
    });
    await expect(
      run((tx) => commitEngagement(tx, cmd(person, request, key), operator)),
    ).rejects.toMatchObject({ code: 'SLOT_FILLED' });
  });
  it('requires every one of several required skills against the real verified evidence', async () => {
    await setup();
    // A second current taxonomy skill the person has no assessment for.
    await publishSyntheticCatalog(1, [
      { id: 'frontend', domain: 'web', name: 'Frontend', status: 'ACTIVE', aliases: ['frontend'] },
      { id: 'backend', domain: 'web', name: 'Backend', status: 'ACTIVE', aliases: ['backend'] },
    ]);
    const backend = { ...skill('D'), skillId: 'backend' };
    const missing = await raid('D', undefined, { requiredSkills: [skill('D'), backend] });
    const reversed = await raid('D', undefined, { requiredSkills: [backend, skill('D')] });
    const unknown = await raid('D', undefined, {
      requiredSkills: [skill('D'), { ...skill('D'), skillId: 'not-in-the-taxonomy' }],
    });
    const one = await raid('A');
    for (const r of [missing, reversed, unknown, one]) await consent(person, r.slot, r.digest);
    for (const r of [missing, reversed, unknown])
      await expect(accept(person, r.slot)).rejects.toMatchObject({
        code: 'ELIGIBILITY_REJECTED',
      });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "Engagement"')).toEqual([]);
    // The verified skill alone still admits under the republished taxonomy.
    expect((await accept(person, one.slot)).engagement.state).toBe('ACCESS_PENDING');
  });
  it('makes a real revocation racing an acceptance wait until the acceptance that read the evidence commits', async () => {
    const fx = await setup();
    const { slot, digest } = await raid('D');
    await consent(person, slot, digest);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const base = host();
    // Pauses the real acceptance just before it reads the evidence (after any lock it has taken).
    const paused: AcceptanceHost = {
      ...base,
      assess: (tx, ctx) =>
        base.assess(
          {
            dialect: tx.dialect,
            isolation: tx.isolation,
            async query(sql, bindings) {
              if (sql.includes('FROM "SkillAssessment"')) {
                locked();
                await released;
              }
              const rows = await tx.query(sql, bindings);
              return rows as never;
            },
          } as typeof tx,
          ctx,
        ),
    };
    let accepting: ReturnType<typeof accept> | undefined;
    let revoking: Promise<unknown> | undefined;
    try {
      accepting = accept(person, slot, paused);
      await holding;
      let revoked = false;
      revoking = fx.decide('REVOKE').finally(() => (revoked = true));
      expect(await until(async () => (await advisoryWaiters()) > 0)).toBe(true);
      expect(revoked).toBe(false);
      release();
      expect((await accepting).engagement.state).toBe('ACCESS_PENDING');
      await revoking;
      const [state] = (await db.$queryRawUnsafe(
        'SELECT v."state"::text FROM "SkillAssessment" a JOIN "SkillAssessmentVersion" v ON v."id"=a."currentVersionId" WHERE a."participantId"=(SELECT "id" FROM "Participant" WHERE "accountId"=$1)',
        person.accountId,
      )) as { state: string }[];
      expect(state.state).toBe('REVOKED');
    } finally {
      release();
      await Promise.allSettled([accepting, revoking]);
    }
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
    await expect(accept(other.actor, slot)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
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
