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
import { assertOffer, findParticipantOffer } from './admission-acceptance';
import {
  fail,
  validate,
  session,
  currentHuman,
  clock,
  definition,
  assertOpenForTaking,
  source,
} from './engagement-authority';

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
      // Share-lock the listing then the slot, the order every slot writer uses, so a concurrent fill queues behind this
      // consent and one that already committed is read below. The database guard takes the same locks as a backstop.
      const slot = await source(tx, value.slotId, 'SHARE');
      const [stored] = await tx.query<{ digest: string }>(
        'SELECT "digest" FROM "TermsVersion" WHERE "id"=$1::uuid',
        [slot.termsVersionId],
      );
      if (!stored) fail('NOT_FOUND');
      if (slot.state === 'FILLED') fail('SLOT_FILLED');
      if (slot.state !== 'AVAILABLE' || slot.listingState !== 'OPEN') fail('PUBLICATION_BLOCKED');
      if (
        slot.termsVersionId !== value.termsVersionId ||
        slot.currentTermsVersionId !== value.termsVersionId ||
        stored.digest !== value.termsDigest
      )
        fail('TERMS_VERSION_CHANGED');
      // Pre-screen with acceptance's own checks and codes. The Raid rows are share-locked above, but the offer and
      // terms reads below take no lock: a concurrent revoke can still land, and acceptance rechecks everything.
      const terms = await definition(tx, value.termsVersionId);
      const now = await clock(tx);
      assertOpenForTaking(terms, now);
      if (terms.admission === 'APPLICATION') {
        const offer = await findParticipantOffer(
          tx,
          {
            participantId: auth.participantId,
            slotId: value.slotId,
            termsVersionId: value.termsVersionId,
          },
          now,
        );
        if (!offer) fail('ADMISSION_REQUIRED');
        assertOffer(offer, value, auth.participantId, now);
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
