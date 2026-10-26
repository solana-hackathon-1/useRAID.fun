import { randomUUID } from 'node:crypto';
import { db } from '../../src/lib/db';
import { hash } from '../../src/lib/auth-primitives';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { commitEngagement } from '../../src/work-loop/engagement-storage';
import { submitWork, decideReview } from '../../src/work-loop/submission-storage';
import { submitApplication } from '../../src/work-loop/admission-storage';
import { raidTerms } from './raid-terms-fixture';
import { assertTestDatabase, truncateAll } from './db-guard';
import { seedWorkSlot, syntheticAcceptanceHost } from './work-loop-db';
import { cmd, workInput, reviewInput } from './work-lifecycle';

export { db };
/** Fixed synthetic account ids; the preview server allowlists only the founder as a listing operator. */
export const accountIds = {
  worker: 'synthetic-worker',
  reviewer: 'synthetic-reviewer',
  founder: 'founder-synthetic',
  applicant: 'synthetic-applicant',
  stranger: 'synthetic-stranger',
} as const;
async function human(id: string) {
  const user = await db.user.create({ data: { id, handle: id, role: 'CREATOR' } });
  const participant = await db.participant.create({
    data: {
      accountId: user.id,
      provisionActorAccountId: user.id,
      provisionRequestId: 'synthetic-' + id,
    },
  });
  const cookie = randomUUID();
  await db.session.create({
    data: {
      tokenHash: hash(cookie),
      userId: user.id,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  return {
    id,
    cookie,
    participantId: participant.id,
    actor: { accountId: id, sessionHash: hash(cookie) },
  };
}
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
/** Synthetic-only accounts, one accepted IN_PROGRESS engagement and one open application listing. */
export async function seedWorkWorkspaceFixture() {
  assertTestDatabase();
  await truncateAll(db);
  const worker = await human(accountIds.worker),
    reviewer = await human(accountIds.reviewer),
    founder = await human(accountIds.founder),
    applicant = await human(accountIds.applicant),
    stranger = await human(accountIds.stranger);
  const slot = await seedWorkSlot(db, accountIds.founder, {
    review: { ...raidTerms().review, reviewerAccountId: reviewer.id },
  });
  const accepted = await run((tx) =>
    commitEngagement(
      tx,
      cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      syntheticAcceptanceHost,
    ),
  );
  const engagementId = accepted.engagement.id;
  // Setup and binding belong to another task; the synthetic host moves the engagement through the guarded transition.
  const start = () =>
    db.$executeRawUnsafe(
      `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
      engagementId,
    );
  await start();
  const applicationSlot = await seedWorkSlot(db, accountIds.founder, { admission: 'APPLICATION' });
  const application = await run((tx) =>
    submitApplication(
      tx,
      cmd(applicant.actor, {
        slotId: applicationSlot.slotId,
        termsVersionId: applicationSlot.termsVersionId,
        evidenceRefs: ['synthetic:portfolio'],
      }),
      { allowNewWrites: true, applicationLimit: 5, authorize: async () => false },
    ),
  );
  return {
    worker,
    reviewer,
    founder,
    applicant,
    stranger,
    engagementId,
    applicationId: application.application.id,
    submitOutsideBrowser: (n = 1) =>
      run((tx) =>
        submitWork(tx, cmd(worker.actor, workInput(engagementId, n)), { allowNewWrites: true }),
      ),
    decideOutsideBrowser: (
      submissionId: string,
      decision: 'ACCEPT' | 'REQUEST_REVISION' | 'DISPUTE',
    ) =>
      run((tx) =>
        decideReview(tx, cmd(reviewer.actor, reviewInput(submissionId, decision)), {
          allowNewWrites: true,
        }),
      ),
  };
}
