import {
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import type { WorkCommand } from './contracts';
import {
  ConsentResultSchema,
  RecordConsentInput,
  type ConsentHost,
  type ConsentResult,
} from './consent-contracts';
import { publicationProblems } from './terms';
import { fail, validate, session, currentHuman, clock, definition } from './engagement-authority';

const COLUMNS =
  'c."id"::text,c."participantId"::text,c."slotId"::text,c."termsVersionId"::text,c."termsDigest",c."consentedAt"';
/** Records the member's consent to the exact current terms of an available slot. Append-only and idempotent. */
export async function recordAcceptanceConsent(
  tx: Tx,
  command: WorkCommand,
  host: ConsentHost,
): Promise<ConsentResult> {
  validate(tx, command?.actor);
  if (typeof host?.allowNewWrites !== 'boolean') fail('STORAGE_CONTRACT');
  const parsed = RecordConsentInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RecordAcceptanceConsent',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      auth = await currentHuman(tx, actor);
      const rows = await tx.query<{
        state: string;
        listingState: string;
        currentTermsVersionId: string;
        termsVersionId: string;
        digest: string;
        listingId: string;
        guildId: string;
      }>(
        `SELECT s."state",l."state" AS "listingState",l."currentTermsVersionId"::text,s."termsVersionId"::text,t."digest",l."id"::text AS "listingId",l."guildId"
         FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=s."termsVersionId"
         WHERE s."id"=$1::uuid`,
        [value.slotId],
      );
      if (rows.length !== 1) fail('NOT_FOUND');
      const slot = rows[0];
      if (slot.state === 'FILLED') fail('SLOT_FILLED');
      if (slot.state !== 'AVAILABLE' || slot.listingState !== 'OPEN') fail('PUBLICATION_BLOCKED');
      if (
        slot.termsVersionId !== value.termsVersionId ||
        slot.currentTermsVersionId !== value.termsVersionId ||
        slot.digest !== value.termsDigest
      )
        fail('TERMS_VERSION_CHANGED');
      // Same gates as acceptance, so consent cannot be recorded for work that can no longer be taken.
      const terms = await definition(tx, value.termsVersionId);
      if (publicationProblems(terms, await clock(tx)).length) fail('DEADLINE_PASSED');
      if (terms.admission === 'APPLICATION') {
        const offers = await tx.query<{ id: string }>(
          `SELECT "id"::text FROM "RaidOffer" WHERE "participantId"=$1::uuid AND "slotId"=$2::uuid AND "termsVersionId"=$3::uuid AND "state"='PENDING' AND "expiresAt">clock_timestamp()`,
          [auth.participantId, value.slotId, value.termsVersionId],
        );
        if (offers.length < 1) fail('ADMISSION_REQUIRED');
      }
      const inserted = await tx.query<{ id: string }>(
        'INSERT INTO "WorkAcceptanceConsent" ("participantId","slotId","termsVersionId","termsDigest") VALUES ($1::uuid,$2::uuid,$3::uuid,$4) ON CONFLICT ("participantId","slotId","termsVersionId") DO NOTHING RETURNING "id"::text',
        [auth.participantId, value.slotId, value.termsVersionId, value.termsDigest],
      );
      // A person who already consented to these exact terms keeps that one consent.
      const id =
        inserted[0]?.id ??
        (
          await tx.query<{ id: string }>(
            'SELECT "id"::text FROM "WorkAcceptanceConsent" WHERE "participantId"=$1::uuid AND "slotId"=$2::uuid AND "termsVersionId"=$3::uuid',
            [auth.participantId, value.slotId, value.termsVersionId],
          )
        )[0]?.id;
      if (!id) fail('STORAGE_CONTRACT');
      await currentHuman(tx, actor, auth.locks);
      return {
        resultRef: id,
        events: [
          {
            type: 'work.acceptance_consented.v1',
            aggregateId: slot.listingId,
            aggregateVersion: 1,
            guildId: slot.guildId,
            payload: { raidSlotId: value.slotId, termsVersionId: value.termsVersionId },
          },
        ],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM "WorkAcceptanceConsent" c WHERE c."id"=$1::uuid AND c."participantId"=$2::uuid`,
    [receipt.resultRef, auth.participantId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const consentedAt = rows[0].consentedAt;
  const result = ConsentResultSchema.safeParse({
    status: receipt.status,
    consent: {
      ...rows[0],
      consentedAt: consentedAt instanceof Date ? consentedAt.toISOString() : consentedAt,
    },
  });
  if (!result.success) fail('STORAGE_CONTRACT');
  await session(tx, actor);
  return result.data;
}
