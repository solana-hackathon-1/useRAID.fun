import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { commitEngagement } from '../../src/work-loop/engagement-storage';
import { submitWork, decideReview } from '../../src/work-loop/submission-storage';
import { raidTerms } from './raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './work-loop-db';
export type Actor = { accountId: string; sessionHash: string };
export const cmd = (actor: Actor, input: unknown, key: string = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: key,
});
export const at = (ms: number) => new Date(Date.now() + ms).toISOString();
export const workInput = (engagementId: string, n = 1) => ({
  engagementId,
  expectedSubmissionNumber: n,
  explanation: 'Guide written and verified on a clean machine.',
  artifacts: [
    { kind: 'COMMIT' as const, ref: 'synthetic://repo/setup.md', immutableVersion: 'a'.repeat(40) },
  ],
  dependencies: ['Public synthetic repository'],
  aiUsage: null,
});
export const reviewInput = (
  submissionId: string,
  decision: 'ACCEPT' | 'REQUEST_REVISION' | 'DISPUTE',
  revisionDeadline: string | null = decision === 'REQUEST_REVISION' ? at(3600000) : null,
) => ({
  submissionId,
  decision,
  reason: 'Reviewed against the accepted criteria.',
  criteria: [
    decision === 'ACCEPT'
      ? { index: 0, result: 'MET' as const, evidence: 'Installation output attached.' }
      : { index: 0, result: 'UNMET' as const, evidence: 'Step three fails.' },
  ],
  revisionDeadline,
});
/** An accepted, started engagement whose terms name a distinct reviewer. Funding is simulated. */
export async function seedEngagement(
  db: PrismaClient,
  override: Partial<ReturnType<typeof raidTerms>> = {},
  options: {
    start?: boolean;
    founderId?: string;
    reviewer?: Awaited<ReturnType<typeof seedWorkHuman>>;
  } = {},
) {
  const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
    runCommandTransaction(db, work);
  const worker = await seedWorkHuman(db),
    reviewer = options.reviewer ?? (await seedWorkHuman(db, 'reviewer-' + randomUUID()));
  const slot = await seedWorkSlot(db, options.founderId, {
    review: { ...raidTerms().review, reviewerAccountId: reviewer.actor.accountId },
    ...override,
  });
  const accepted = await run((tx) =>
    commitEngagement(
      tx,
      cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      syntheticAcceptanceHost,
    ),
  );
  const engagementId = accepted.engagement.id;
  if (options.start !== false)
    await db.$executeRawUnsafe(
      `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
      engagementId,
    );
  return {
    worker,
    reviewer,
    slot,
    engagementId,
    submit: (n = 1) =>
      run((tx) =>
        submitWork(tx, cmd(worker.actor, workInput(engagementId, n)), { allowNewWrites: true }),
      ),
    decide: (submissionId: string, decision: 'ACCEPT' | 'REQUEST_REVISION' | 'DISPUTE') =>
      run((tx) =>
        decideReview(tx, cmd(reviewer.actor, reviewInput(submissionId, decision)), {
          allowNewWrites: true,
        }),
      ),
  };
}
