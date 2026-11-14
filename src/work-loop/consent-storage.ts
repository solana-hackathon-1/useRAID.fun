import {
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import type { WorkCommand } from './contracts';
import {
  ConsentResultSchema,
  ConsentWithdrawalResultSchema,
  RecordConsentInput,
  WithdrawConsentInput,
  type ConsentHost,
  type ConsentResult,
  type ConsentWithdrawalResult,
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
      // The latest consent for these exact terms is the only one that can be live. A person who already holds a live
      // one keeps it; after a withdrawal a new consent is the next generation (the database allows no other).
      const latest = () =>
        tx.query<{ id: string; generation: number; withdrawn: boolean }>(
          `SELECT c."id"::text,c."generation",EXISTS (SELECT 1 FROM "WorkAcceptanceConsentWithdrawal" w WHERE w."consentId"=c."id") AS withdrawn
           FROM "WorkAcceptanceConsent" c WHERE c."participantId"=$1::uuid AND c."slotId"=$2::uuid AND c."termsVersionId"=$3::uuid
           ORDER BY c."generation" DESC LIMIT 1`,
          [auth!.participantId, value.slotId, value.termsVersionId],
        );
      const [current] = await latest();
      let id = current && !current.withdrawn ? current.id : undefined;
      if (!id) {
        const inserted = await tx.query<{ id: string }>(
          'INSERT INTO "WorkAcceptanceConsent" ("participantId","slotId","termsVersionId","termsDigest","generation") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::int) ON CONFLICT ("participantId","slotId","termsVersionId","generation") DO NOTHING RETURNING "id"::text',
          [
            auth.participantId,
            value.slotId,
            value.termsVersionId,
            value.termsDigest,
            String((current?.generation ?? 0) + 1),
          ],
        );
        // Two requests re-consenting at once insert the same generation: one wins and both report that one consent.
        const settled = inserted[0]?.id ?? (await latest()).find((row) => !row.withdrawn)?.id;
        if (!settled) fail('STORAGE_CONTRACT');
        id = settled;
      }
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
/**
 * The consenting participant withdraws an unused consent (DEC-2026-11-14-07, #275-4). Deliberately takes no host: it only
 * reduces commitment, so `WORK_ACCEPTANCE_ENABLED` and the write kill switch never gate it (as application withdrawal).
 * A signed-out or suspended account still cannot act. It locks the consent row FOR UPDATE, the row acceptance holds FOR
 * SHARE until its engagement commits, so the two serialize and whichever commits first wins: a used consent is
 * `CONSENT_USED`; an acceptance never uses a withdrawn one. It changes no engagement and releases no capacity.
 */
export async function withdrawAcceptanceConsent(
  tx: Tx,
  command: WorkCommand,
): Promise<ConsentWithdrawalResult> {
  validate(tx, command?.actor);
  const parsed = WithdrawConsentInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'WithdrawAcceptanceConsent',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      auth = await currentHuman(tx, actor);
      // Ownership is read without a lock so a stranger can neither wait on nor learn about another person's consent.
      const own = await tx.query<{ slotId: string }>(
        'SELECT "slotId"::text FROM "WorkAcceptanceConsent" WHERE "id"=$1::uuid AND "participantId"=$2::uuid',
        [value.consentId, auth.participantId],
      );
      if (own.length !== 1) fail('NOT_FOUND');
      // Acceptance reads this row FOR SHARE, so this waits for an in-flight acceptance and then sees its engagement.
      const locked = await tx.query(
        'SELECT 1 FROM "WorkAcceptanceConsent" WHERE "id"=$1::uuid FOR UPDATE',
        [value.consentId],
      );
      if (locked.length !== 1) fail('STORAGE_CONTRACT');
      const existing = await tx.query(
        'SELECT 1 FROM "WorkAcceptanceConsentWithdrawal" WHERE "consentId"=$1::uuid',
        [value.consentId],
      );
      // Withdrawn once already (by another key): recorded once, so nothing more to do or to report as new.
      if (existing.length) fail('CONSENT_WITHDRAWN');
      const used = await tx.query(
        `SELECT 1 FROM "Engagement" e WHERE e."slotId"=$1::uuid AND jsonb_typeof(e."acceptedTerms"->'roster')='array'
         AND e."acceptedTerms"->'roster' @> jsonb_build_array(jsonb_build_object('consentRef', $2::text))`,
        [own[0].slotId, value.consentId],
      );
      if (used.length) fail('CONSENT_USED');
      const [listing] = await tx.query<{ listingId: string; guildId: string }>(
        'SELECT l."id"::text AS "listingId",l."guildId" FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" WHERE s."id"=$1::uuid',
        [own[0].slotId],
      );
      if (!listing) fail('STORAGE_CONTRACT');
      const inserted = await tx.query<{ id: string }>(
        'INSERT INTO "WorkAcceptanceConsentWithdrawal" ("consentId","participantId") VALUES ($1::uuid,$2::uuid) RETURNING "id"::text',
        [value.consentId, auth.participantId],
      );
      if (inserted.length !== 1) fail('STORAGE_CONTRACT');
      await currentHuman(tx, actor, auth.locks);
      return {
        resultRef: inserted[0].id,
        events: [
          {
            type: 'work.acceptance_consent_withdrawn.v1',
            aggregateId: listing.listingId,
            aggregateVersion: 1,
            guildId: listing.guildId,
            payload: { raidSlotId: own[0].slotId },
          },
        ],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const rows = await tx.query<Record<string, unknown>>(
    'SELECT w."id"::text,w."consentId"::text,w."withdrawnAt" FROM "WorkAcceptanceConsentWithdrawal" w WHERE w."id"=$1::uuid AND w."participantId"=$2::uuid',
    [receipt.resultRef, auth.participantId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const withdrawnAt = rows[0].withdrawnAt;
  const result = ConsentWithdrawalResultSchema.safeParse({
    status: receipt.status,
    withdrawal: {
      ...rows[0],
      withdrawnAt: withdrawnAt instanceof Date ? withdrawnAt.toISOString() : withdrawnAt,
    },
  });
  if (!result.success) fail('STORAGE_CONTRACT');
  await session(tx, actor);
  return result.data;
}
