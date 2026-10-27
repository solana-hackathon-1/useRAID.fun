import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { submitWork, decideReview } from '../src/work-loop/submission-storage';
import { closeOverdueEngagement, readOwnEngagementClosure } from '../src/work-loop/closure-storage';
import { saveRaidTerms } from '../src/work-loop/storage';
import {
  proposeAmendment,
  respondToAmendment,
  withdrawAmendment,
  readEffectiveTerms,
} from '../src/work-loop/amendment-storage';
import { reissueRaid } from '../src/work-loop/replacement-storage';
import type { AmendmentHost } from '../src/work-loop/amendment-contracts';
import type { WorkHost } from '../src/work-loop/contracts';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
type Actor = { accountId: string; sessionHash: string };
const cmd = (actor: Actor, input: unknown, key: string = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: key,
});
const calls = { reserve: 0, available: 0, consent: 0 };
let funded = true;
let consenting = true;
const revoked = new Set<string>();
const host: AmendmentHost = {
  allowNewWrites: true,
  authorize: async (_tx, a) =>
    !revoked.has(a.accountId) &&
    (a.accountId.startsWith('founder-') || a.accountId.startsWith('admin-')),
  authorizeProposer: async (_tx, a) =>
    !revoked.has(a.accountId) &&
    (a.accountId.startsWith('founder-') || a.accountId.startsWith('admin-')),
  reserveAdditionalFunding: async (_tx, b) => {
    calls.reserve += 1;
    return funded ? 'synthetic-increase:' + b.amendmentId : null;
  },
  fundingAvailable: async () => {
    calls.available += 1;
    return funded;
  },
  assessConsent: async (_tx, c) => {
    calls.consent += 1;
    return consenting ? { consentRef: 'synthetic-amendment-consent:' + c.participantId } : null;
  },
};
const day = 86400000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const base = raidTerms();
const work = (engagementId: string, n = 1) => ({
  engagementId,
  expectedSubmissionNumber: n,
  explanation: 'Guide written and verified on a clean machine.',
  artifacts: [
    { kind: 'COMMIT' as const, ref: 'synthetic://repo/setup.md', immutableVersion: 'a'.repeat(40) },
  ],
  dependencies: [],
  aiUsage: null,
});
async function setup(override: Partial<ReturnType<typeof raidTerms>> = {}) {
  const founder = await seedWorkHuman(db, 'founder-' + randomUUID());
  const worker = await seedWorkHuman(db);
  const reviewer = await seedWorkHuman(db, 'reviewer-' + randomUUID());
  const slot = await seedWorkSlot(db, founder.actor.accountId, {
    review: { ...base.review, reviewerAccountId: reviewer.actor.accountId },
    ...override,
  });
  const accepted = await run((tx) =>
    commitEngagement(
      tx,
      cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      syntheticAcceptanceHost,
    ),
  );
  return { founder, worker, reviewer, slot, engagementId: accepted.engagement.id, accepted };
}
const start = (engagementId: string) =>
  db.$executeRawUnsafe(
    `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
    engagementId,
  );
const propose = (actor: Actor, input: unknown, h: AmendmentHost = host, key?: string) =>
  run((tx) => proposeAmendment(tx, cmd(actor, input, key), h));
const respond = (actor: Actor, input: unknown, h: AmendmentHost = host, key?: string) =>
  run((tx) => respondToAmendment(tx, cmd(actor, input, key), h));
const withdraw = (actor: Actor, input: unknown, h: AmendmentHost = host) =>
  run((tx) => withdrawAmendment(tx, cmd(actor, input), h));
const submit = (actor: Actor, input: unknown) =>
  run((tx) => submitWork(tx, cmd(actor, input), { allowNewWrites: true }));
const decide = (actor: Actor, input: unknown) =>
  run((tx) => decideReview(tx, cmd(actor, input), { allowNewWrites: true }));
const row = async <T>(sql: string, ...args: string[]) =>
  (await db.$queryRawUnsafe(sql, ...args)) as T[];
const engagement = async (id: string) =>
  (
    await row<{ state: string; revision: number; acceptedDigest: string }>(
      'SELECT "state","revision","acceptedDigest" FROM "Engagement" WHERE "id"=$1::uuid',
      id,
    )
  )[0];
const change = (engagementId: string, changes: unknown, expiresAt = at(3600000)) => ({
  engagementId,
  changes,
  expiresAt,
});
const raise = { rewards: [{ amount: '1500000000' }] };
integration('T025 consented amendments and replacement contracts', { timeout: 60000 }, () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    calls.reserve = calls.available = calls.consent = 0;
    funded = consenting = true;
    revoked.clear();
  });
  afterAll(() => db.$disconnect());
  it('keeps the accepted version effective until the affected member consents, then versions it with funding', async () => {
    const { founder, worker, engagementId } = await setup();
    await start(engagementId);
    const before = await engagement(engagementId);
    const input = change(engagementId, {
      ...raise,
      deadlines: { submission: shift(base.deadlines.submission, day / 2) },
    });
    const proposed = await propose(founder.actor, input);
    expect(proposed.amendment).toMatchObject({ state: 'PROPOSED', sequence: 1 });
    expect(proposed.amendment.requiresFunding).toBe(true);
    expect(calls.reserve).toBe(1);
    // A proposal changes nothing: the member's effective terms are still the accepted promise.
    const unchanged = await run((tx) => readEffectiveTerms(tx, worker.actor, engagementId));
    expect(unchanged.rewards[0].amount).toBe('1000000000');
    expect(unchanged.deadlines.submission).toBe(base.deadlines.submission);
    expect(await row('SELECT 1 FROM "EngagementAmendment" WHERE "state"=\'ACCEPTED\'')).toEqual([]);
    const agreed = await respond(worker.actor, {
      amendmentId: proposed.amendment.id,
      decision: 'ACCEPT',
    });
    expect(agreed.amendment.state).toBe('ACCEPTED');
    expect(calls.consent).toBe(1);
    expect(calls.available).toBe(1);
    const effective = await run((tx) => readEffectiveTerms(tx, worker.actor, engagementId));
    expect(effective.rewards[0].amount).toBe('1500000000');
    expect(effective.deadlines.submission).toBe(shift(base.deadlines.submission, day / 2));
    // The original accepted contract and its digest are untouched; the amendment is a retained, audited version.
    expect(await engagement(engagementId)).toEqual(before);
    const stored = await row<{ digest: string; additionalFundingRef: string; consentRef: string }>(
      'SELECT "digest","additionalFundingRef","consentRef" FROM "EngagementAmendment"',
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].additionalFundingRef).toBe('synthetic-increase:' + proposed.amendment.id);
    expect(stored[0].consentRef).toBe('synthetic-amendment-consent:' + worker.participantId);
    expect(
      await row(
        'SELECT "eventType" FROM "AuditEvent" WHERE "eventType" IN (\'work.amendment_proposed.v1\',\'work.amendment_accepted.v1\') ORDER BY "eventType"',
      ),
    ).toHaveLength(2);
  });
  it('rejects unilateral Founder, admin and listing-edit overwrites of accepted terms', async () => {
    const { founder, worker, engagementId, slot } = await setup();
    await start(engagementId);
    const admin = await seedWorkHuman(db, 'admin-' + randomUUID());
    const stranger = await seedWorkHuman(db, 'stranger-' + randomUUID());
    // A host-authorized admin who is not the listing's Founder cannot propose; an unauthorized actor cannot either.
    await expect(propose(admin.actor, change(engagementId, raise))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(propose(stranger.actor, change(engagementId, raise))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // The assigned member cannot propose against their own engagement either.
    await expect(propose(worker.actor, change(engagementId, raise))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // The original edit path stays frozen once a slot is assigned.
    const listing = await row<{ revision: number }>(
      'SELECT "revision" FROM "WorkListing" WHERE "id"=$1::uuid',
      slot.listingId,
    );
    const listingHost: WorkHost = {
      allowNewWrites: true,
      authorize: async () => true,
      reserveSimulatedFunding: async () => 'unused',
    };
    await expect(
      run((tx) =>
        saveRaidTerms(
          tx,
          cmd(founder.actor, {
            listingId: slot.listingId,
            expectedRevision: listing[0].revision,
            guildId: 'synthetic-guild',
            terms: { ...base, rewards: [{ ...base.rewards[0], amount: '1' }] },
          }),
          listingHost,
        ),
      ),
    ).rejects.toMatchObject({ code: 'TERMS_FROZEN' });
    // The Founder cannot decide for the member, and a proposal alone never alters the effective version.
    const proposed = await propose(founder.actor, change(engagementId, raise));
    await expect(
      respond(founder.actor, { amendmentId: proposed.amendment.id, decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      respond(stranger.actor, { amendmentId: proposed.amendment.id, decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const effective = await run((tx) => readEffectiveTerms(tx, worker.actor, engagementId));
    expect(effective.rewards[0].amount).toBe('1000000000');
    // Database bypasses: accepted terms are immutable and no ACCEPTED amendment exists without the member's consent.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "Engagement" SET "acceptedTerms"=jsonb_set("acceptedTerms",'{rewards,0,amount}','"1"') WHERE "id"=$1::uuid`,
        engagementId,
      ),
    ).rejects.toThrow(/Accepted engagement terms and identity are immutable/);
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "EngagementAmendment" SET "state"='ACCEPTED',"decidedByAccountId"=$2,"decidedAt"=clock_timestamp() WHERE "id"=$1::uuid`,
        proposed.amendment.id,
        founder.actor.accountId,
      ),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "EngagementAmendment" SET "state"='ACCEPTED',"decidedByAccountId"=$2,"consentRef"='forged',"decidedAt"=clock_timestamp() WHERE "id"=$1::uuid`,
        proposed.amendment.id,
        founder.actor.accountId,
      ),
    ).rejects.toThrow(/member/);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "EngagementAmendment" ("engagementId","sequence","snapshot","digest","proposedByAccountId","expiresAt","state","decidedByAccountId","consentRef","decidedAt") SELECT "id",9,"acceptedTerms",'${'a'.repeat(64)}',$2,clock_timestamp()+interval '1 hour','ACCEPTED',$2,'forged',clock_timestamp() FROM "Engagement" WHERE "id"=$1::uuid`,
        engagementId,
        founder.actor.accountId,
      ),
    ).rejects.toThrow(/PROPOSED/);
    // Even a correctly sequenced direct insert cannot change the roster, a beneficiary or any non-amendable term.
    for (const path of [
      '{roster,0,consentRef}',
      '{rewards,0,beneficiaryRef}',
      '{eligibilityPolicyVersion}',
    ])
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "EngagementAmendment" ("engagementId","sequence","snapshot","digest","proposedByAccountId","expiresAt") SELECT "id",(SELECT COALESCE(max("sequence"),0)+1 FROM "EngagementAmendment" WHERE "engagementId"="Engagement"."id"),jsonb_set("acceptedTerms",'${path}','"forged"'),'${'c'.repeat(64)}',$2,clock_timestamp()+interval '1 hour' FROM "Engagement" WHERE "id"=$1::uuid`,
          engagementId,
          founder.actor.accountId,
        ),
      ).rejects.toThrow(
        /Only scope, acceptance criteria, reward amounts and deadlines are amendable|Reward policy and beneficiary are fixed/,
      );
    expect(await row('SELECT 1 FROM "EngagementAmendment" WHERE "state"=\'ACCEPTED\'')).toEqual([]);
  });
  it('requires exact funding for a reward increase and the member current consent', async () => {
    const { founder, worker, engagementId } = await setup();
    await start(engagementId);
    funded = false;
    await expect(propose(founder.actor, change(engagementId, raise))).rejects.toMatchObject({
      code: 'FUNDING_REQUIRED',
    });
    expect(await row('SELECT 1 FROM "EngagementAmendment"')).toEqual([]);
    // A reward decrease needs consent but no new funding.
    const lowered = await propose(
      founder.actor,
      change(engagementId, { rewards: [{ amount: '1' }] }),
    );
    expect(lowered.amendment.requiresFunding).toBe(false);
    expect(calls.reserve).toBe(1);
    consenting = false;
    await expect(
      respond(worker.actor, { amendmentId: lowered.amendment.id, decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    await withdraw(founder.actor, { amendmentId: lowered.amendment.id });
    funded = true;
    consenting = true;
    const raised = await propose(founder.actor, change(engagementId, raise));
    funded = false;
    await expect(
      respond(worker.actor, { amendmentId: raised.amendment.id, decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    expect(
      (
        await row<{ state: string }>(
          'SELECT "state" FROM "EngagementAmendment" WHERE "id"=$1::uuid',
          raised.amendment.id,
        )
      )[0].state,
    ).toBe('PROPOSED');
    // Direct SQL cannot add an increase without its funding reference.
    await withdraw(founder.actor, { amendmentId: raised.amendment.id });
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "EngagementAmendment" ("engagementId","sequence","snapshot","digest","proposedByAccountId","expiresAt") SELECT "id",(SELECT COALESCE(max("sequence"),0)+1 FROM "EngagementAmendment" WHERE "engagementId"="Engagement"."id"),jsonb_set("acceptedTerms",'{rewards,0,amount}','"1500000000"'),'${'b'.repeat(64)}',$2,clock_timestamp()+interval '1 hour' FROM "Engagement" WHERE "id"=$1::uuid`,
        engagementId,
        founder.actor.accountId,
      ),
    ).rejects.toThrow(/funding/i);
  });
  it('declines, withdraws, expires and serializes proposals without changing the accepted version', async () => {
    const { founder, worker, engagementId } = await setup();
    await start(engagementId);
    const first = await propose(
      founder.actor,
      change(engagementId, { scope: 'A narrower scope.' }),
    );
    await expect(
      propose(founder.actor, change(engagementId, { scope: 'Another scope.' })),
    ).rejects.toMatchObject({ code: 'AMENDMENT_EXISTS' });
    const declined = await respond(worker.actor, {
      amendmentId: first.amendment.id,
      decision: 'DECLINE',
    });
    expect(declined.amendment.state).toBe('DECLINED');
    await expect(
      respond(worker.actor, { amendmentId: first.amendment.id, decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'AMENDMENT_UNAVAILABLE' });
    const second = await propose(founder.actor, change(engagementId, { scope: 'Second scope.' }));
    expect(second.amendment.sequence).toBe(2);
    await withdraw(founder.actor, { amendmentId: second.amendment.id });
    await expect(
      withdraw(founder.actor, { amendmentId: second.amendment.id }),
    ).rejects.toMatchObject({ code: 'AMENDMENT_UNAVAILABLE' });
    const brief = await propose(
      founder.actor,
      change(engagementId, { scope: 'Brief scope.' }, at(1200)),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(
      respond(worker.actor, { amendmentId: brief.amendment.id, decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'AMENDMENT_UNAVAILABLE' });
    const effective = await run((tx) => readEffectiveTerms(tx, worker.actor, engagementId));
    expect(effective.scope).toBe(
      JSON.stringify({
        outcome: base.outcome,
        deliverables: base.deliverables,
        exclusions: base.exclusions,
        dependencies: base.dependencies,
      }),
    );
    // Replays return the original outcome, never a duplicate proposal.
    const key = randomUUID();
    await withdraw(founder.actor, { amendmentId: brief.amendment.id }).catch(() => undefined);
    const request = change(engagementId, { scope: 'Replay scope.' });
    const again = await propose(founder.actor, request, host, key);
    const replay = await propose(founder.actor, request, { ...host, allowNewWrites: false }, key);
    expect(replay.status).toBe('REPLAYED');
    expect(replay.amendment.id).toBe(again.amendment.id);
    expect(
      await row('SELECT 1 FROM "EngagementAmendment" WHERE "state"=\'PROPOSED\''),
    ).toHaveLength(1);
  });
  it('rejects no-op, malformed, immutable-field and past-deadline amendments', async () => {
    const { founder, engagementId } = await setup();
    await start(engagementId);
    await expect(propose(founder.actor, change(engagementId, {}))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      propose(founder.actor, change(engagementId, { rewards: [{ amount: '1000000000' }] })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      propose(founder.actor, change(engagementId, { rewards: [{ amount: '0' }] })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      propose(founder.actor, change(engagementId, { rewards: [{ amount: '1' }, { amount: '2' }] })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      propose(founder.actor, { ...change(engagementId, { scope: 'x' }), extra: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      propose(founder.actor, change(engagementId, { reviewer: 'someone-else' })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      propose(founder.actor, change(engagementId, { deadlines: { submission: at(-1000) } })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      propose(
        founder.actor,
        change(engagementId, {
          deadlines: { submission: shift(base.deadlines.operationalClosure, day) },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      propose(founder.actor, change(engagementId, { scope: 'x' }, at(-1000))),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      propose(founder.actor, change(engagementId, { scope: 'x' }), {
        ...host,
        allowNewWrites: false,
      }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(await row('SELECT 1 FROM "EngagementAmendment"')).toEqual([]);
  });
  it('carries agreed criteria and deadlines into submission, review and closure claims', async () => {
    const { founder, worker, reviewer, engagementId } = await setup();
    await start(engagementId);
    const criteria = ['The guide installs cleanly.', 'The guide lists every dependency.'];
    const proposed = await propose(
      founder.actor,
      change(engagementId, {
        acceptanceCriteria: criteria,
        rewards: [{ amount: '2000000000' }],
      }),
    );
    await respond(worker.actor, { amendmentId: proposed.amendment.id, decision: 'ACCEPT' });
    const sub = await submit(worker.actor, work(engagementId));
    // Review must judge the agreed two criteria, not the originally accepted one.
    await expect(
      decide(reviewer.actor, {
        submissionId: sub.submission.id,
        decision: 'ACCEPT',
        reason: 'Looks fine.',
        criteria: [{ index: 0, result: 'MET', evidence: null }],
        revisionDeadline: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await decide(reviewer.actor, {
      submissionId: sub.submission.id,
      decision: 'ACCEPT',
      reason: 'Both criteria are met.',
      criteria: [
        { index: 0, result: 'MET', evidence: null },
        { index: 1, result: 'MET', evidence: null },
      ],
      revisionDeadline: null,
    });
    const claim = await run((tx) => readOwnEngagementClosure(tx, worker.actor, engagementId));
    expect(claim.claims[0]).toMatchObject({ amount: '2000000000', status: 'UNSETTLED' });
    // A closed engagement can no longer be amended.
    await expect(
      propose(founder.actor, change(engagementId, { scope: 'Late scope.' })),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE' });
  });
  it('refuses amendment of submitted work and lets an agreed earlier deadline bind submission', async () => {
    const early = await setup();
    await start(early.engagementId);
    const proposed = await propose(
      early.founder.actor,
      change(early.engagementId, { deadlines: { preparation: at(1000), submission: at(1500) } }),
    );
    await respond(early.worker.actor, { amendmentId: proposed.amendment.id, decision: 'ACCEPT' });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await expect(submit(early.worker.actor, work(early.engagementId))).rejects.toMatchObject({
      code: 'DEADLINE_PASSED',
    });
    const sent = await setup();
    await start(sent.engagementId);
    const pending = await propose(
      sent.founder.actor,
      change(sent.engagementId, { scope: 'Different job.' }),
    );
    await submit(sent.worker.actor, work(sent.engagementId));
    // Work received under the accepted promise cannot be re-scoped, even by an already open proposal.
    await expect(
      respond(sent.worker.actor, { amendmentId: pending.amendment.id, decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE' });
    await expect(
      propose(sent.founder.actor, change(sent.engagementId, { scope: 'Another job.' })),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE' });
  });
  it('lets only one outcome win when consent races the member submission', async () => {
    for (let i = 0; i < 4; i += 1) {
      await truncateAll(db);
      const { founder, worker, engagementId } = await setup();
      await start(engagementId);
      const proposed = await propose(
        founder.actor,
        change(engagementId, { acceptanceCriteria: ['Only the agreed criterion.'] }),
      );
      const results = await Promise.allSettled([
        respond(worker.actor, { amendmentId: proposed.amendment.id, decision: 'ACCEPT' }),
        submit(worker.actor, work(engagementId)),
      ]);
      const state = (await engagement(engagementId)).state;
      const accepted = await row('SELECT 1 FROM "EngagementAmendment" WHERE "state"=\'ACCEPTED\'');
      // Either the member's work was submitted under the original promise or the amendment was agreed first.
      if (state === 'SUBMITTED') expect(results[1].status).toBe('fulfilled');
      else expect(accepted).toHaveLength(1);
      if (results[0].status === 'fulfilled' && results[1].status === 'fulfilled') {
        const stored = await row<{ number: number }>(
          'SELECT max("submissionNumber")::int AS number FROM "WorkSubmission"',
        );
        expect(stored[0].number).toBe(1);
      }
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    }
  });
  it('refuses consent to a proposal whose Founder lost authority after proposing, while declining stays possible', async () => {
    const { founder, worker, engagementId } = await setup();
    await start(engagementId);
    const proposed = await propose(
      founder.actor,
      change(engagementId, { acceptanceCriteria: ['Only the agreed criterion.'] }),
    );
    revoked.add(founder.actor.accountId);
    await expect(
      respond(worker.actor, { amendmentId: proposed.amendment.id, decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'AMENDMENT_UNAVAILABLE' });
    expect(await row('SELECT 1 FROM "EngagementAmendment" WHERE "state"=\'ACCEPTED\'')).toEqual([]);
    const declined = await respond(worker.actor, {
      amendmentId: proposed.amendment.id,
      decision: 'DECLINE',
    });
    expect(declined.amendment.state).toBe('DECLINED');
  });
  it('reports a proposal whose amended deadlines lapsed before consent as AMENDMENT_UNAVAILABLE', async () => {
    const { founder, worker, engagementId } = await setup();
    await start(engagementId);
    const proposed = await propose(
      founder.actor,
      change(engagementId, {
        deadlines: {
          preparation: at(800),
          submission: at(1200),
          review: at(1600),
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(
      respond(worker.actor, { amendmentId: proposed.amendment.id, decision: 'ACCEPT' }),
    ).rejects.toMatchObject({ code: 'AMENDMENT_UNAVAILABLE' });
    expect(await row('SELECT 1 FROM "EngagementAmendment" WHERE "state"=\'ACCEPTED\'')).toEqual([]);
  });
  it('reports a reused funding reference as FUNDING_REQUIRED, never as unavailable storage', async () => {
    const { founder, slot, engagementId } = await setup();
    await start(engagementId);
    const slotRef = (
      await row<{ ref: string }>(
        'SELECT "fundingRef" AS ref FROM "RaidSlot" WHERE "id"=$1::uuid',
        slot.slotId,
      )
    )[0].ref;
    const reuse = (ref: string): AmendmentHost => ({
      ...host,
      reserveAdditionalFunding: async () => ref,
    });
    await expect(
      propose(founder.actor, change(engagementId, raise), reuse(slotRef)),
    ).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    const first = await propose(
      founder.actor,
      change(engagementId, raise),
      reuse('amendment-ref-1'),
    );
    await withdraw(founder.actor, { amendmentId: first.amendment.id });
    await expect(
      propose(founder.actor, change(engagementId, raise), reuse('amendment-ref-1')),
    ).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    expect(await row('SELECT 1 FROM "EngagementAmendment" WHERE "state"=\'PROPOSED\'')).toEqual([]);
  });
  it('serializes a slot and an amendment handed the same funding reference across concurrent writers', async () => {
    const { founder, slot, engagementId } = await setup();
    await start(engagementId);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const amendmentWritten = new Promise<void>((resolve) => (inserted = resolve));
    const amendment = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "EngagementAmendment" ("engagementId","sequence","snapshot","digest","proposedByAccountId","additionalFundingRef","expiresAt") SELECT "id",1,jsonb_set("acceptedTerms",'{rewards,0,amount}','"1500000000"'),'${'b'.repeat(64)}',$2,'race-ref',clock_timestamp()+interval '1 hour' FROM "Engagement" WHERE "id"=$1::uuid`,
          engagementId,
          founder.actor.accountId,
        );
        inserted();
        await held;
      },
      { timeout: 20000 },
    );
    await amendmentWritten;
    const raced = db.$transaction(
      (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "RaidSlot" ("listingId","termsVersionId","slotNumber","fundingRef") VALUES ($1::uuid,$2::uuid,99,'race-ref')`,
          slot.listingId,
          slot.termsVersionId,
        ),
      { timeout: 20000 },
    );
    const outcome = await Promise.race([
      raced.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 700)),
    ]);
    expect(outcome).toBe('waiting');
    release();
    await amendment;
    await expect(raced).rejects.toThrow(/funding reference/i);
    expect(await row('SELECT 1 FROM "RaidSlot" WHERE "fundingRef"=\'race-ref\'')).toEqual([]);
  });
  const overdue = () => ({
    commitment: at(6000),
    preparation: at(6500),
    submission: at(7000),
    review: at(7500),
    operationalClosure: at(8000),
  });
  const reissueInput = (engagementId: string, terms: unknown = base) => ({ engagementId, terms });
  const founderHost = (founderId: string, reservations: string[] = []): WorkHost => ({
    allowNewWrites: true,
    authorize: async (_tx, a, g) => a.accountId === founderId && g === 'synthetic-guild',
    reserveSimulatedFunding: async (_tx, b) => {
      const ref = 'synthetic-replacement:' + b.slotId;
      reservations.push(ref);
      return ref;
    },
  });
  it('replaces a terminated worker with a new slot, terms and reservation, preserving the original claim', async () => {
    const original = await setup({ deadlines: overdue() });
    const ops = await seedWorkHuman(db, 'ops-' + randomUUID());
    const opsHost = { allowNewWrites: true, authorize: async () => true };
    const live = await engagement(original.engagementId);
    await expect(
      run((tx) =>
        reissueRaid(
          tx,
          cmd(original.founder.actor, reissueInput(original.engagementId, replacementTerms())),
          founderHost(original.founder.actor.accountId),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE' });
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(overdueEnd(original)) - Date.now() + 400)),
    );
    await run((tx) =>
      closeOverdueEngagement(
        tx,
        cmd(ops.actor, { engagementId: original.engagementId, expectedRevision: live.revision }),
        opsHost,
      ),
    );
    const reservations: string[] = [];
    const key = randomUUID();
    const reissued = await run((tx) =>
      reissueRaid(
        tx,
        cmd(original.founder.actor, reissueInput(original.engagementId, replacementTerms()), key),
        founderHost(original.founder.actor.accountId, reservations),
      ),
    );
    expect(reissued).toMatchObject({
      status: 'EXECUTED',
      replacesEngagementId: original.engagementId,
      fundingMode: 'SIMULATED',
    });
    expect(reissued.slotId).not.toBe(original.slot.slotId);
    expect(reissued.termsVersionId).not.toBe(original.slot.termsVersionId);
    const slots = await row<{ id: string; state: string; fundingRef: string }>(
      'SELECT "id"::text,"state","fundingRef" FROM "RaidSlot" ORDER BY "createdAt"',
    );
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ id: original.slot.slotId, state: 'FILLED' });
    expect(slots[1]).toMatchObject({ id: reissued.slotId, state: 'AVAILABLE' });
    expect(slots[1].fundingRef).toBe(reservations[0]);
    expect(slots[1].fundingRef).not.toBe(slots[0].fundingRef);
    // Original engagement, closure and unsettled claim are intact and still visible to the original worker.
    expect((await engagement(original.engagementId)).state).toBe('TERMINATED');
    const claim = await run((tx) =>
      readOwnEngagementClosure(tx, original.worker.actor, original.engagementId),
    );
    expect(claim.claims[0]).toMatchObject({ amount: '1000000000', status: 'UNSETTLED' });
    expect(
      await row(
        'SELECT 1 FROM "RaidReplacement" WHERE "originalEngagementId"=$1::uuid AND "replacementSlotId"=$2::uuid',
        original.engagementId,
        reissued.slotId,
      ),
    ).toHaveLength(1);
    // The replacement is an ordinary new slot: a different worker commits to it under its new terms.
    const next = await seedWorkHuman(db);
    const committed = await run((tx) =>
      commitEngagement(
        tx,
        cmd(next.actor, { slotId: reissued.slotId, termsVersionId: reissued.termsVersionId }),
        syntheticAcceptanceHost,
      ),
    );
    expect(committed.engagement.acceptedTerms.rewards[0].amount).toBe('1200000000');
    // Replay returns the original outcome even with writes off; a new request for the same attempt is refused.
    const replay = await run((tx) =>
      reissueRaid(
        tx,
        cmd(original.founder.actor, reissueInput(original.engagementId, replacementTerms()), key),
        { ...founderHost(original.founder.actor.accountId), allowNewWrites: false },
      ),
    );
    expect(replay).toMatchObject({ status: 'REPLAYED', slotId: reissued.slotId });
    await expect(
      run((tx) =>
        reissueRaid(
          tx,
          cmd(original.founder.actor, reissueInput(original.engagementId, replacementTerms())),
          founderHost(original.founder.actor.accountId),
        ),
      ),
    ).rejects.toMatchObject({ code: 'REPLACEMENT_EXISTS' });
    // Direct SQL cannot link an engagement that is not a closed, unaccepted attempt.
    const other = await setup();
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "RaidReplacement" ("originalEngagementId","originalSlotId","replacementSlotId","createdByAccountId") VALUES ($1::uuid,$2::uuid,$3::uuid,$4)`,
        other.engagementId,
        other.slot.slotId,
        reissued.slotId,
        other.founder.actor.accountId,
      ),
    ).rejects.toThrow(/terminated/i);
  });
  it('refuses unauthorized, unfunded, accepted-work and disabled replacements without creating anything', async () => {
    const { founder, engagementId } = await setup();
    await start(engagementId);
    const intruder = await seedWorkHuman(db, 'founder-' + randomUUID());
    const input = reissueInput(engagementId, replacementTerms());
    await expect(
      run((tx) => reissueRaid(tx, cmd(founder.actor, input), founderHost(founder.actor.accountId))),
    ).rejects.toMatchObject({ code: 'ENGAGEMENT_STATE' });
    await expect(
      run((tx) =>
        reissueRaid(tx, cmd(intruder.actor, input), founderHost(intruder.actor.accountId)),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      run((tx) =>
        reissueRaid(tx, cmd(founder.actor, input), { ...founderHost('x'), allowNewWrites: false }),
      ),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(await row('SELECT 1 FROM "WorkListing"')).toHaveLength(1);
    expect(await row('SELECT 1 FROM "RaidReplacement"')).toEqual([]);
  });
});
function replacementTerms() {
  return {
    ...base,
    title: 'Replacement documentation task',
    rewards: [{ ...base.rewards[0], amount: '1200000000' }],
  };
}
function overdueEnd(e: { slot: { terms: { deadlines: { operationalClosure: string } } } }) {
  return e.slot.terms.deadlines.operationalClosure;
}
