import { recordSimulatedReservation } from './reservation-storage';
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import { InternalId } from '../contracts/ids';
import type { WorkCommand, WorkHost } from './contracts';
import { publicationProblems } from './terms';
import { ReissueRaidInput, ReissuedRaidSchema } from './replacement-contracts';
import { fail, validate, session, currentActor, clock } from './engagement-authority';

function hostContract(host: WorkHost) {
  if (
    typeof host?.allowNewWrites !== 'boolean' ||
    typeof host.authorize !== 'function' ||
    typeof host.reserveSimulatedFunding !== 'function'
  )
    fail('STORAGE_CONTRACT');
}
/**
 * Replaces a terminated worker: the original slot, engagement, closure, claim and reservation stay exactly as they are.
 * A fresh listing/terms/slot with its own simulated reservation is published and linked to the earlier attempt.
 */
export async function reissueRaid(tx: Tx, command: WorkCommand, host: WorkHost) {
  validate(tx, command?.actor);
  hostContract(host);
  const parsed = ReissueRaidInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let locks: Awaited<ReturnType<typeof currentActor>> | undefined;
  const authorize = async (guildId: string, creator: string) => {
    if (
      creator !== actor.accountId ||
      (await host.authorize(tx, actor, guildId, 'MANAGE_LISTING')) !== true
    )
      fail('FORBIDDEN');
  };
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ReissueRaid',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      locks = await currentActor(tx, actor);
      // Missing and unauthorized engagements are one indistinguishable denial.
      const refs = await tx.query<{ guildId: string; creatorAccountId: string }>(
        'SELECT e."guildId",l."creatorAccountId" FROM "Engagement" e JOIN "RaidSlot" s ON s."id"=e."slotId" JOIN "WorkListing" l ON l."id"=s."listingId" WHERE e."id"=$1::uuid',
        [value.engagementId],
      );
      if (refs.length !== 1) fail('FORBIDDEN');
      const { guildId, creatorAccountId } = refs[0];
      await authorize(guildId, creatorAccountId);
      const locked = await tx.query<{ state: string; slotId: string }>(
        'SELECT "state","slotId"::text FROM "Engagement" WHERE "id"=$1::uuid FOR UPDATE',
        [value.engagementId],
      );
      if (locked.length !== 1) fail('STORAGE_CONTRACT');
      if (locked[0].state !== 'TERMINATED') fail('ENGAGEMENT_STATE');
      const prior = await tx.query(
        'SELECT 1 FROM "RaidReplacement" WHERE "originalEngagementId"=$1::uuid',
        [value.engagementId],
      );
      if (prior.length) fail('REPLACEMENT_EXISTS');
      if (publicationProblems(value.terms, await clock(tx)).length) fail('PUBLICATION_BLOCKED');
      const [listing] = await tx.query<{ id: string }>(
        'INSERT INTO "WorkListing" ("guildId","creatorAccountId") VALUES ($1,$2) RETURNING "id"::text',
        [guildId, actor.accountId],
      );
      const [version] = await tx.query<{ id: string }>(
        'INSERT INTO "TermsVersion" ("listingId","revision","snapshot","digest") VALUES ($1::uuid,1,$2::jsonb,$3) RETURNING "id"::text',
        [listing.id, JSON.stringify(value.terms), canonicalRequestDigest(value.terms)],
      );
      await tx.query(
        'UPDATE "WorkListing" SET "currentTermsVersionId"=$2::uuid,"revision"=1,"state"=\'DRAFT\' WHERE "id"=$1::uuid RETURNING "id"',
        [listing.id, version.id],
      );
      const [slot] = await tx.query<{ id: string }>(
        'INSERT INTO "RaidSlot" ("listingId","termsVersionId","slotNumber") VALUES ($1::uuid,$2::uuid,1) RETURNING "id"::text',
        [listing.id, version.id],
      );
      const funding = await host.reserveSimulatedFunding(tx, {
        slotId: slot.id,
        termsVersionId: version.id,
        terms: value.terms,
      });
      if (!InternalId.safeParse(funding).success) fail('FUNDING_REQUIRED');
      await recordSimulatedReservation(
        tx,
        { slotId: slot.id, termsVersionId: version.id, terms: value.terms },
        funding as string,
      );
      await tx.query('UPDATE "RaidSlot" SET "fundingRef"=$2 WHERE "id"=$1::uuid RETURNING "id"', [
        slot.id,
        funding,
      ]);
      await tx.query(
        'UPDATE "WorkListing" SET "state"=\'OPEN\' WHERE "id"=$1::uuid RETURNING "id"',
        [listing.id],
      );
      await tx.query(
        'INSERT INTO "RaidReplacement" ("originalEngagementId","originalSlotId","replacementSlotId","createdByAccountId") VALUES ($1::uuid,$2::uuid,$3::uuid,$4) RETURNING "originalEngagementId"',
        [value.engagementId, locked[0].slotId, slot.id, actor.accountId],
      );
      // Authority is proven again after every lock and host callback wait.
      await currentActor(tx, actor, locks);
      await authorize(guildId, creatorAccountId);
      return {
        resultRef: slot.id,
        events: [
          {
            type: 'work.raid_reissued.v1',
            aggregateId: listing.id,
            aggregateVersion: 1,
            guildId,
            payload: {
              raidSlotId: slot.id,
              termsVersionId: version.id,
              engagementId: value.engagementId,
            },
          },
        ],
      };
    },
  );
  await currentActor(tx, actor, locks);
  const rows = await tx.query<{
    slotId: string;
    listingId: string;
    termsVersionId: string;
    engagementId: string;
    guildId: string;
    creatorAccountId: string;
  }>(
    'SELECT r."replacementSlotId"::text AS "slotId",s."listingId"::text AS "listingId",s."termsVersionId"::text AS "termsVersionId",r."originalEngagementId"::text AS "engagementId",l."guildId",l."creatorAccountId" FROM "RaidReplacement" r JOIN "RaidSlot" s ON s."id"=r."replacementSlotId" JOIN "WorkListing" l ON l."id"=s."listingId" WHERE r."replacementSlotId"=$1::uuid',
    [receipt.resultRef],
  );
  if (rows.length !== 1 || rows[0].engagementId !== value.engagementId) fail('STORAGE_CONTRACT');
  await authorize(rows[0].guildId, rows[0].creatorAccountId);
  const result = ReissuedRaidSchema.parse({
    status: receipt.status,
    listingId: rows[0].listingId,
    termsVersionId: rows[0].termsVersionId,
    slotId: rows[0].slotId,
    replacesEngagementId: rows[0].engagementId,
    fundingMode: 'SIMULATED',
  });
  await session(tx, actor);
  return result;
}
