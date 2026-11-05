import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { saveRaidTerms, publishRaid } from '../../src/work-loop/storage';
import { commitEngagement } from '../../src/work-loop/engagement-storage';
import { submitWork, decideReview } from '../../src/work-loop/submission-storage';
import type { WorkHost } from '../../src/work-loop/contracts';
import { raidTerms } from './raid-terms-fixture';
import { seedWorkHuman, syntheticAcceptanceHost } from './work-loop-db';
import { cmd, reviewInput, workInput } from './work-lifecycle';

type Human = Awaited<ReturnType<typeof seedWorkHuman>>;
const run = <T>(db: PrismaClient, work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);

/** Synthetic-only: publishes one simulated-funded slot under the given Guild id (a persisted Guild or not). */
export async function publishGuildSlot(
  db: PrismaClient,
  guildId: string,
  admission: 'INSTANT' | 'APPLICATION' = 'INSTANT',
) {
  const founderId = 'founder-' + randomUUID();
  await db.user.create({ data: { id: founderId, handle: founderId } });
  const actor = { accountId: founderId, sessionHash: 'f'.repeat(64) };
  const host: WorkHost = {
    allowNewWrites: true,
    authorize: async (_tx, who, guild) => who.accountId === founderId && guild === guildId,
    reserveSimulatedFunding: async (_tx, binding) => 'synthetic:' + binding.slotId,
  };
  const reviewer = await seedWorkHuman(db, 'reviewer-' + randomUUID());
  const terms = {
    ...raidTerms(),
    admission,
    review: { ...raidTerms().review, reviewerAccountId: reviewer.actor.accountId },
  };
  const saved = await run(db, (tx) =>
    saveRaidTerms(
      tx,
      {
        actor,
        input: { listingId: null, expectedRevision: 0, guildId, terms },
        idempotencyKey: randomUUID(),
        requestId: 'metrics-save',
      },
      host,
    ),
  );
  const published = await run(db, (tx) =>
    publishRaid(
      tx,
      {
        actor,
        input: { listingId: saved.listingId, termsVersionId: saved.termsVersionId },
        idempotencyKey: randomUUID(),
        requestId: 'metrics-publish',
      },
      host,
    ),
  );
  return { ...published, reviewer, guildId };
}

/** Accepts a published slot as `worker`, starts it, and optionally submits and has the reviewer accept the work. */
export async function engage(
  db: PrismaClient,
  slot: Awaited<ReturnType<typeof publishGuildSlot>>,
  worker: Human,
  outcome: 'ACCEPTED' | 'IN_PROGRESS' = 'IN_PROGRESS',
) {
  const accepted = await run(db, (tx) =>
    commitEngagement(
      tx,
      cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      syntheticAcceptanceHost,
    ),
  );
  const engagementId = accepted.engagement.id;
  await db.$executeRawUnsafe(
    `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
    engagementId,
  );
  if (outcome === 'ACCEPTED') {
    const submitted = await run(db, (tx) =>
      submitWork(tx, cmd(worker.actor, workInput(engagementId, 1)), { allowNewWrites: true }),
    );
    await run(db, (tx) =>
      decideReview(tx, cmd(slot.reviewer.actor, reviewInput(submitted.submission.id, 'ACCEPT')), {
        allowNewWrites: true,
      }),
    );
  }
  return engagementId;
}
