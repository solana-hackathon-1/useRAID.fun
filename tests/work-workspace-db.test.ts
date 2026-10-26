import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { submitApplication, issueOffer } from '../src/work-loop/admission-storage';
import type { AdmissionHost } from '../src/work-loop/admission-contracts';
import {
  readMyRaids,
  readReviewQueue,
  readApplicantQueue,
} from '../src/work-loop/workspace-storage';
import { seedWorkHuman, seedWorkSlot } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { at, cmd, seedEngagement } from './helpers/work-lifecycle';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const admission: AdmissionHost = {
  allowNewWrites: true,
  applicationLimit: 5,
  authorize: async (_tx, a) => a.accountId.startsWith('founder-'),
};
integration('T022 My Raid, review and applicant read models', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('shows a member their engagement progress, review feedback and next step', async () => {
    const e = await seedEngagement(db);
    const waiting = await run((tx) => readMyRaids(tx, e.worker.actor));
    expect(waiting.engagements).toHaveLength(1);
    expect(waiting.engagements[0]).toMatchObject({
      engagementId: e.engagementId,
      state: 'IN_PROGRESS',
      capacityHeld: true,
      nextStep: 'SUBMIT_WORK',
      submissionCount: 0,
      maxSubmissions: 2,
      closure: null,
      claims: [],
    });
    expect(waiting.engagements[0].criteria).toEqual([
      { index: 0, text: expect.any(String), result: null, evidence: null },
    ]);
    const first = await e.submit();
    await e.decide(first.submission.id, 'REQUEST_REVISION');
    const revising = (await run((tx) => readMyRaids(tx, e.worker.actor))).engagements[0];
    expect(revising).toMatchObject({
      state: 'REVISION_REQUESTED',
      nextStep: 'REVISE_AND_RESUBMIT',
      submissionCount: 1,
      latestReview: { decision: 'REQUEST_REVISION', reason: expect.any(String) },
    });
    expect(revising.latestReview?.revisionDeadline).toEqual(expect.any(String));
    expect(revising.criteria[0]).toMatchObject({ result: 'UNMET', evidence: 'Step three fails.' });
    const second = await e.submit(2);
    expect((await run((tx) => readMyRaids(tx, e.worker.actor))).engagements[0].nextStep).toBe(
      'AWAIT_REVIEW',
    );
    await e.decide(second.submission.id, 'ACCEPT');
    const done = (await run((tx) => readMyRaids(tx, e.worker.actor))).engagements[0];
    expect(done).toMatchObject({
      state: 'ACCEPTED',
      capacityHeld: false,
      nextStep: 'CLOSED',
      closure: { reason: 'ACCEPTED', finalState: 'ACCEPTED' },
    });
    expect(done.claims).toEqual([
      expect.objectContaining({
        amount: e.slot.terms.rewards[0].amount,
        beneficiaryParticipantId: e.worker.participantId,
        status: 'UNSETTLED',
      }),
    ]);
  });
  it('never shows an engagement to anyone but its members', async () => {
    const e = await seedEngagement(db);
    await e.submit();
    const stranger = await seedWorkHuman(db);
    for (const actor of [stranger.actor, e.reviewer.actor])
      expect((await run((tx) => readMyRaids(tx, actor))).engagements).toEqual([]);
    await expect(
      run((tx) => readMyRaids(tx, { ...e.worker.actor, sessionHash: 'e'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('shows a member their applications and offers, with database-time expiry', async () => {
    const applicant = await seedWorkHuman(db),
      founder = await seedWorkHuman(db, 'founder-' + randomUUID());
    const slot = await seedWorkSlot(db, founder.actor.accountId, { admission: 'APPLICATION' });
    const application = await run((tx) =>
      submitApplication(
        tx,
        cmd(applicant.actor, {
          slotId: slot.slotId,
          termsVersionId: slot.termsVersionId,
          evidenceRefs: ['synthetic:portfolio'],
        }),
        admission,
      ),
    );
    const mine = await run((tx) => readMyRaids(tx, applicant.actor));
    expect(mine.applications).toEqual([
      expect.objectContaining({
        applicationId: application.application.id,
        state: 'SUBMITTED',
        offer: null,
        title: slot.terms.title,
      }),
    ]);
    const offer = await run((tx) =>
      issueOffer(
        tx,
        cmd(founder.actor, { applicationId: application.application.id, expiresAt: at(1500) }),
        admission,
      ),
    );
    const pending = (await run((tx) => readMyRaids(tx, applicant.actor))).applications[0];
    expect(pending.offer).toMatchObject({
      offerId: offer.offer.id,
      state: 'PENDING',
      expired: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(
      (await run((tx) => readMyRaids(tx, applicant.actor))).applications[0].offer,
    ).toMatchObject({ state: 'PENDING', expired: true });
  });
  it('queues only unreviewed latest submissions for the exact terms reviewer', async () => {
    const shared = await seedWorkHuman(db, 'reviewer-' + randomUUID());
    const as = { reviewer: shared };
    const pending = await seedEngagement(db, {}, as),
      disputed = await seedEngagement(db, {}, as),
      accepted = await seedEngagement(db, {}, as),
      idle = await seedEngagement(db, {}, as);
    const sub = await pending.submit();
    const d = await disputed.submit();
    await disputed.decide(d.submission.id, 'DISPUTE');
    const a = await accepted.submit();
    await accepted.decide(a.submission.id, 'ACCEPT');
    void idle;
    const queue = await run((tx) => readReviewQueue(tx, pending.reviewer.actor));
    expect(queue.items).toEqual([
      expect.objectContaining({
        engagementId: pending.engagementId,
        submissionId: sub.submission.id,
        submissionNumber: 1,
        revisionsRemaining: 1,
        explanation: expect.any(String),
        artifacts: [expect.objectContaining({ kind: 'COMMIT' })],
        criteria: [expect.objectContaining({ index: 0, text: expect.any(String) })],
      }),
    ]);
    expect(JSON.stringify(queue)).not.toContain(pending.worker.participantId);
    for (const actor of [pending.worker.actor, (await seedWorkHuman(db)).actor])
      expect((await run((tx) => readReviewQueue(tx, actor))).items).toEqual([]);
  });
  it('shows only a creator with current scoped authority their listing applicants', async () => {
    const founder = await seedWorkHuman(db, 'founder-' + randomUUID()),
      applicant = await seedWorkHuman(db);
    const slot = await seedWorkSlot(db, founder.actor.accountId, { admission: 'APPLICATION' });
    await run((tx) =>
      submitApplication(
        tx,
        cmd(applicant.actor, {
          slotId: slot.slotId,
          termsVersionId: slot.termsVersionId,
          evidenceRefs: ['synthetic:portfolio'],
        }),
        admission,
      ),
    );
    const seen = await run((tx) => readApplicantQueue(tx, founder.actor, admission));
    expect(seen.listings).toEqual([
      expect.objectContaining({
        slotId: slot.slotId,
        title: slot.terms.title,
        applicants: [
          expect.objectContaining({
            evidenceRefs: ['synthetic:portfolio'],
            state: 'SUBMITTED',
            offer: null,
          }),
        ],
      }),
    ]);
    // Authority is current and scoped: a denying host, a non-creator and the applicant all see nothing.
    expect(
      (
        await run((tx) =>
          readApplicantQueue(tx, founder.actor, { ...admission, authorize: async () => false }),
        )
      ).listings,
    ).toEqual([]);
    const other = await seedWorkHuman(db, 'founder-' + randomUUID());
    for (const actor of [other.actor, applicant.actor])
      expect((await run((tx) => readApplicantQueue(tx, actor, admission))).listings).toEqual([]);
  });
});
