import { z } from 'zod';
import { prepareModuleIdentity } from '../identity-locks';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import {
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import type { WorkActor, WorkCommand } from './contracts';
import {
  ApplicationSchema,
  ApplicationResultSchema,
  OfferResultSchema,
  SubmitApplicationInput,
  type AdmissionHost,
} from './admission-contracts';
import { lockOffer } from './admission-acceptance';
import {
  fail,
  validate,
  session,
  currentActor,
  currentHuman,
  source,
  definition,
  clock,
  type Source,
} from './engagement-authority';
import { publicationProblems } from './terms';
const Submit = SubmitApplicationInput;
const Withdraw = z.strictObject({ applicationId: z.uuid() });
const Issue = z.strictObject({ applicationId: z.uuid(), expiresAt: UtcTimestamp });
const Revoke = z.strictObject({ offerId: z.uuid() });
function input<T>(schema: z.ZodType<T>, command: WorkCommand, tx: Tx, host: AdmissionHost): T {
  validate(tx, command?.actor);
  if (
    typeof host?.allowNewWrites !== 'boolean' ||
    typeof host.authorize !== 'function' ||
    !Number.isSafeInteger(host.applicationLimit) ||
    host.applicationLimit < 1 ||
    host.applicationLimit > 100
  )
    fail('STORAGE_CONTRACT');
  const parsed = schema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  return parsed.data;
}
const event = (type: string, s: Source, termsVersionId: string) => ({
  type,
  aggregateId: s.listingId,
  aggregateVersion: s.revision,
  guildId: s.guildId,
  payload: { termsVersionId },
});
async function application(tx: Tx, id: string, lock = false) {
  const rows = await tx.query(
    'SELECT "id"::text,"slotId"::text,"termsVersionId"::text,"participantId"::text,"evidenceRefs","state" FROM "RaidApplication" WHERE "id"=$1::uuid' +
      (lock ? ' FOR UPDATE' : ''),
    [id],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  return ApplicationSchema.parse(rows[0]);
}
async function available(tx: Tx, s: Source, termsVersionId: string) {
  if (s.state === 'FILLED') fail('SLOT_FILLED');
  if (s.state !== 'AVAILABLE' || s.listingState !== 'OPEN') fail('PUBLICATION_BLOCKED');
  if (s.termsVersionId !== termsVersionId || s.currentTermsVersionId !== termsVersionId)
    fail('TERMS_VERSION_CHANGED');
  const terms = await definition(tx, termsVersionId),
    now = await clock(tx);
  if (terms.admission !== 'APPLICATION') fail('INVALID_INPUT');
  const problems = publicationProblems(terms, now);
  if (problems.length)
    fail(problems.includes('DEADLINE_PASSED') ? 'DEADLINE_PASSED' : 'PUBLICATION_BLOCKED');
  return terms;
}
async function founder(
  tx: Tx,
  actor: WorkActor,
  s: Source,
  host: AdmissionHost,
  prelocked?: Awaited<ReturnType<typeof currentActor>>,
) {
  const [row] = await tx.query<{ creatorAccountId: string }>(
    'SELECT "creatorAccountId" FROM "WorkListing" WHERE "id"=$1::uuid',
    [s.listingId],
  );
  if (row?.creatorAccountId !== actor.accountId) fail('FORBIDDEN');
  const locks = await currentActor(tx, actor, prelocked);
  if ((await host.authorize(tx, actor, s.guildId, 'MANAGE_LISTING')) !== true) fail('FORBIDDEN');
  return locks;
}
export async function submitApplication(tx: Tx, command: WorkCommand, host: AdmissionHost) {
  const value = input(Submit, command, tx, host),
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'SubmitRaidApplication',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const s = await source(tx, value.slotId);
      // Exclusive canonical root serializes this participant's application quota across sources.
      auth = await currentHuman(
        tx,
        actor,
        await prepareModuleIdentity(tx, actor.accountId, 'UPDATE'),
      );
      await available(tx, s, value.termsVersionId);
      await session(tx, actor);
      await available(tx, s, value.termsVersionId);
      const existing = await tx.query<{ id: string; live: boolean }>(
        `SELECT a."id"::text, (NOT EXISTS (SELECT 1 FROM "RaidOffer" o WHERE o."applicationId"=a."id") OR EXISTS (SELECT 1 FROM "RaidOffer" o WHERE o."applicationId"=a."id" AND o."state"='PENDING' AND o."expiresAt">clock_timestamp())) AS live FROM "RaidApplication" a WHERE a."slotId"=$1::uuid AND a."participantId"=$2::uuid AND a."state"='SUBMITTED'`,
        [value.slotId, auth.participantId],
      );
      if (existing.some((a) => a.live)) fail('APPLICATION_EXISTS');
      for (const old of existing) {
        await tx.query(
          'UPDATE "RaidOffer" SET "state"=\'REVOKED\' WHERE "applicationId"=$1::uuid AND "state"=\'PENDING\' RETURNING "id"',
          [old.id],
        );
        await tx.query(
          'UPDATE "RaidApplication" SET "state"=\'CLOSED\' WHERE "id"=$1::uuid RETURNING "id"',
          [old.id],
        );
      }
      const [count] = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "RaidApplication" a JOIN "RaidSlot" s ON s."id"=a."slotId" JOIN "WorkListing" l ON l."id"=s."listingId" JOIN "TermsVersion" t ON t."id"=a."termsVersionId" WHERE a."participantId"=$1::uuid AND a."state"='SUBMITTED' AND s."state"='AVAILABLE' AND l."state"='OPEN' AND l."currentTermsVersionId"=a."termsVersionId" AND (t."snapshot"->'deadlines'->>'commitment')::timestamptz>clock_timestamp() AND (NOT EXISTS (SELECT 1 FROM "RaidOffer" o WHERE o."applicationId"=a."id") OR EXISTS (SELECT 1 FROM "RaidOffer" o WHERE o."applicationId"=a."id" AND o."state"='PENDING' AND o."expiresAt">clock_timestamp()))`,
        [auth.participantId],
      );
      if (!count || count.n >= host.applicationLimit) fail('APPLICATION_LIMIT');
      const [a] = await tx.query<{ id: string }>(
        'INSERT INTO "RaidApplication" ("slotId","termsVersionId","participantId","evidenceRefs") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::jsonb) RETURNING "id"::text',
        [
          value.slotId,
          value.termsVersionId,
          auth.participantId,
          JSON.stringify(value.evidenceRefs),
        ],
      );
      return {
        resultRef: a.id,
        events: [event('work.application_submitted.v1', s, value.termsVersionId)],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const saved = await application(tx, receipt.resultRef);
  if (
    saved.participantId !== auth.participantId ||
    saved.slotId !== value.slotId ||
    saved.termsVersionId !== value.termsVersionId
  )
    fail('STORAGE_CONTRACT');
  await currentHuman(tx, actor, auth.locks);
  return ApplicationResultSchema.parse({ status: receipt.status, application: saved });
}
export async function withdrawApplication(tx: Tx, command: WorkCommand, host: AdmissionHost) {
  const value = input(Withdraw, command, tx, host),
    actor = command.actor;
  await session(tx, actor);
  let auth: Awaited<ReturnType<typeof currentHuman>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'WithdrawRaidApplication',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const ref = await application(tx, value.applicationId),
        s = await source(tx, ref.slotId);
      auth = await currentHuman(tx, actor);
      if (ref.participantId !== auth.participantId) fail('FORBIDDEN');
      const a = await application(tx, ref.id, true);
      if (a.state !== 'SUBMITTED') fail('APPLICATION_CLOSED');
      await tx.query(
        'UPDATE "RaidOffer" SET "state"=\'REVOKED\' WHERE "applicationId"=$1::uuid AND "state"=\'PENDING\' RETURNING "id"',
        [ref.id],
      );
      await tx.query(
        'UPDATE "RaidApplication" SET "state"=\'WITHDRAWN\' WHERE "id"=$1::uuid RETURNING "id"',
        [ref.id],
      );
      return {
        resultRef: ref.id,
        events: [event('work.application_withdrawn.v1', s, ref.termsVersionId)],
      };
    },
  );
  auth = await currentHuman(tx, actor, auth?.locks);
  const saved = await application(tx, receipt.resultRef);
  if (saved.participantId !== auth.participantId) fail('FORBIDDEN');
  return ApplicationResultSchema.parse({
    status: receipt.status,
    application: saved,
  });
}
export async function issueOffer(tx: Tx, command: WorkCommand, host: AdmissionHost) {
  const value = input(Issue, command, tx, host),
    actor = command.actor;
  await session(tx, actor);
  let locks: Awaited<ReturnType<typeof currentActor>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'IssueRaidOffer',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const ref = await application(tx, value.applicationId),
        s = await source(tx, ref.slotId);
      locks = await founder(tx, actor, s, host);
      const terms = await available(tx, s, ref.termsVersionId),
        a = await application(tx, ref.id, true);
      if (a.state !== 'SUBMITTED') fail('APPLICATION_CLOSED');
      const now = await clock(tx);
      if (
        Date.parse(value.expiresAt) <= now.getTime() ||
        Date.parse(value.expiresAt) > Date.parse(terms.deadlines.commitment)
      )
        fail('INVALID_INPUT');
      const prior = await tx.query<{ state: string; expiresAt: Date }>(
        'SELECT "state","expiresAt" FROM "RaidOffer" WHERE "applicationId"=$1::uuid',
        [ref.id],
      );
      if (prior.length)
        fail(
          prior.some((o) => o.state === 'PENDING' && o.expiresAt > now)
            ? 'OFFER_EXISTS'
            : 'OFFER_UNAVAILABLE',
        );
      const [o] = await tx.query<{ id: string }>(
        'INSERT INTO "RaidOffer" ("applicationId","slotId","termsVersionId","participantId","offeredByAccountId","expiresAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::timestamptz) RETURNING "id"::text',
        [
          ref.id,
          ref.slotId,
          ref.termsVersionId,
          ref.participantId,
          actor.accountId,
          value.expiresAt,
        ],
      );
      return { resultRef: o.id, events: [event('work.offer_issued.v1', s, ref.termsVersionId)] };
    },
  );
  const ref = await application(tx, value.applicationId),
    s = await source(tx, ref.slotId);
  await founder(tx, actor, s, host, locks);
  await session(tx, actor);
  return OfferResultSchema.parse({
    status: receipt.status,
    offer: await lockOffer(tx, receipt.resultRef),
  });
}
export async function revokeOffer(tx: Tx, command: WorkCommand, host: AdmissionHost) {
  const value = input(Revoke, command, tx, host),
    actor = command.actor;
  await session(tx, actor);
  let locks: Awaited<ReturnType<typeof currentActor>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RevokeRaidOffer',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const [ref] = await tx.query<{ slotId: string }>(
        'SELECT "slotId"::text FROM "RaidOffer" WHERE "id"=$1::uuid',
        [value.offerId],
      );
      if (!ref) fail('NOT_FOUND');
      const s = await source(tx, ref.slotId);
      locks = await founder(tx, actor, s, host);

      const o = await lockOffer(tx, value.offerId);
      if (o.state !== 'PENDING') fail('OFFER_UNAVAILABLE');
      await tx.query(
        'UPDATE "RaidOffer" SET "state"=\'REVOKED\' WHERE "id"=$1::uuid RETURNING "id"',
        [o.id],
      );
      await tx.query(
        'UPDATE "RaidApplication" SET "state"=\'CLOSED\' WHERE "id"=$1::uuid AND "state"=\'SUBMITTED\' RETURNING "id"',
        [o.applicationId],
      );
      return { resultRef: o.id, events: [event('work.offer_revoked.v1', s, o.termsVersionId)] };
    },
  );
  const [ref] = await tx.query<{ slotId: string }>(
    'SELECT "slotId"::text FROM "RaidOffer" WHERE "id"=$1::uuid',
    [receipt.resultRef],
  );
  if (!ref) fail('NOT_FOUND');
  const s = await source(tx, ref.slotId);
  await founder(tx, actor, s, host, locks);
  await session(tx, actor);
  return OfferResultSchema.parse({
    status: receipt.status,
    offer: await lockOffer(tx, receipt.resultRef),
  });
}
