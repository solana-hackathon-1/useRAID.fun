import { randomUUID, createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { saveRaidTerms, publishRaid } from '../../src/work-loop/storage';
import type { WorkActor, WorkHost } from '../../src/work-loop/contracts';
import type { AcceptanceHost } from '../../src/work-loop/engagement-contracts';
import { raidTerms } from './raid-terms-fixture';
export async function seedWorkHuman(db: PrismaClient, id = 'human-' + randomUUID()) {
  const user = await db.user.upsert({ where: { id }, create: { id, handle: id }, update: {} });
  const actor: WorkActor = {
    accountId: user.id,
    sessionHash: createHash('sha256').update(id).digest('hex'),
  };
  await db.session.create({
    data: {
      tokenHash: actor.sessionHash,
      userId: id,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const participant = await db.participant.create({
    data: { accountId: id, provisionActorAccountId: id, provisionRequestId: 'fixture:' + id },
  });
  return { actor, participantId: participant.id };
}
export const syntheticAcceptanceHost: AcceptanceHost = {
  allowNewWrites: true,
  assess: async (_tx, c) => ({
    consentRef: 'synthetic-consent:' + c.participantId,
    beneficiaryRef: 'synthetic-beneficiary:' + c.participantId,
    eligibilityPolicyVersion: 'synthetic-starter-v1',
    operatorId: null,
  }),
  fundingAvailable: async () => true,
};
export async function seedWorkSlot(db: PrismaClient, founderId = 'founder-' + randomUUID()) {
  await db.user.upsert({
    where: { id: founderId },
    create: { id: founderId, handle: founderId },
    update: {},
  });
  const actor = { accountId: founderId, sessionHash: 'f'.repeat(64) };
  const host: WorkHost = {
    allowNewWrites: true,
    authorize: async (_tx, a, g) => a.accountId === founderId && g === 'synthetic-guild',
    reserveSimulatedFunding: async (_tx, b) => 'synthetic:' + b.slotId,
  };
  const saved = await runCommandTransaction(db, (tx) =>
    saveRaidTerms(
      tx,
      {
        actor,
        input: {
          listingId: null,
          expectedRevision: 0,
          guildId: 'synthetic-guild',
          terms: raidTerms(),
        },
        idempotencyKey: randomUUID(),
        requestId: 'fixture-save',
      },
      host,
    ),
  );
  const published = await runCommandTransaction(db, (tx) =>
    publishRaid(
      tx,
      {
        actor,
        input: { listingId: saved.listingId, termsVersionId: saved.termsVersionId },
        idempotencyKey: randomUUID(),
        requestId: 'fixture-publish',
      },
      host,
    ),
  );
  return { ...published, terms: saved.terms };
}
