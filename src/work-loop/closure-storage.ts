import {
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import { TermsSnapshotSchema } from '../contracts/entities';
import type { WorkCommand } from './contracts';
import {
  CloseOverdueInput,
  CloseResultSchema,
  ClosureSchema,
  OwnClosureSchema,
  type ClosureHost,
} from './closure-contracts';
import { fail, validate, session, currentActor, currentHuman, clock } from './engagement-authority';

export type ClosureReason =
  'ACCEPTED' | 'ACCESS_TIMEOUT' | 'SUBMISSION_TIMEOUT' | 'REVIEW_TIMEOUT' | 'REVISION_TIMEOUT';
const TIMEOUT_REASON: Readonly<Record<string, ClosureReason>> = {
  ACCESS_PENDING: 'ACCESS_TIMEOUT',
  IN_PROGRESS: 'SUBMISSION_TIMEOUT',
  SUBMITTED: 'REVIEW_TIMEOUT',
  REVISION_REQUESTED: 'REVISION_TIMEOUT',
};
/**
 * Closes the work duty in the caller's transaction: closure record, terminal state and release of exactly this
 * engagement's own participant reservations. Never touches rewards, accepted terms or another engagement's capacity.
 * The caller holds the engagement row lock and has verified the state/authority preconditions.
 */
export async function closeEngagement(
  tx: Tx,
  engagementId: string,
  participantIds: readonly string[],
  reason: ClosureReason,
  closedByAccountId: string,
) {
  const finalState = reason === 'ACCEPTED' ? 'ACCEPTED' : 'TERMINATED';
  await tx.query(
    'INSERT INTO "EngagementClosure" ("engagementId","reason","finalState","closedByAccountId") VALUES ($1::uuid,$2,$3,$4) RETURNING "engagementId"',
    [engagementId, reason, finalState, closedByAccountId],
  );
  await tx.query(
    'UPDATE "Engagement" SET "state"=$2,"revision"="revision"+1 WHERE "id"=$1::uuid RETURNING "id"',
    [engagementId, finalState],
  );
  let released = 0;
  for (const participantId of participantIds) {
    // The release matches both keys, so a delayed cleanup can never free a newer engagement's reservation.
    const gone = await tx.query(
      'DELETE FROM "ActiveCommitment" WHERE "engagementId"=$1::uuid AND "participantId"=$2::uuid RETURNING "participantId"',
      [engagementId, participantId],
    );
    released += gone.length;
  }
  if (released !== participantIds.length) fail('STORAGE_CONTRACT');
}
async function readClosure(tx: Tx, engagementId: string) {
  const rows = await tx.query<Record<string, unknown>>(
    'SELECT "engagementId"::text,"reason","finalState","financialResolution","closedAt" FROM "EngagementClosure" WHERE "engagementId"=$1::uuid',
    [engagementId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const closedAt = rows[0].closedAt;
  const parsed = ClosureSchema.safeParse({
    ...rows[0],
    closedAt: closedAt instanceof Date ? closedAt.toISOString() : closedAt,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
/** Operations closure once the accepted operational deadline has passed. Silence decides no money and no fault. */
export async function closeOverdueEngagement(tx: Tx, command: WorkCommand, host: ClosureHost) {
  validate(tx, command?.actor);
  if (typeof host?.allowNewWrites !== 'boolean' || typeof host.authorize !== 'function')
    fail('STORAGE_CONTRACT');
  const parsed = CloseOverdueInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    actor = command.actor;
  await session(tx, actor);
  let locks: Awaited<ReturnType<typeof currentActor>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'CloseOverdueEngagement',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      locks = await currentActor(tx, actor);
      // Missing and unauthorized engagements are one indistinguishable denial.
      const ref = await tx.query<{ guildId: string }>(
        'SELECT "guildId" FROM "Engagement" WHERE "id"=$1::uuid',
        [value.engagementId],
      );
      if (
        ref.length !== 1 ||
        (await host.authorize(tx, actor, {
          engagementId: value.engagementId,
          guildId: ref[0].guildId,
        })) !== true
      )
        fail('FORBIDDEN');
      const rows = await tx.query<{
        state: string;
        revision: number;
        guildId: string;
        acceptedTerms: unknown;
      }>(
        'SELECT "state","revision","guildId","acceptedTerms" FROM "Engagement" WHERE "id"=$1::uuid FOR UPDATE',
        [value.engagementId],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      const e = rows[0];
      const reason = TIMEOUT_REASON[e.state];
      if (!reason) fail('ENGAGEMENT_STATE');
      if (e.revision !== value.expectedRevision) fail('REVISION_CONFLICT');
      const terms = TermsSnapshotSchema.safeParse(e.acceptedTerms);
      if (!terms.success) fail('STORAGE_CONTRACT');
      if (Date.parse(terms.data.deadlines.operationalClosure) > (await clock(tx)).getTime())
        fail('DEADLINE_NOT_REACHED');
      const members = await tx.query<{ participantId: string }>(
        'SELECT "participantId"::text FROM "EngagementMember" WHERE "engagementId"=$1::uuid',
        [value.engagementId],
      );
      // Authority is proven again after the engagement lock wait.
      await currentActor(tx, actor, locks);
      if (
        (await host.authorize(tx, actor, {
          engagementId: value.engagementId,
          guildId: e.guildId,
        })) !== true
      )
        fail('FORBIDDEN');
      await closeEngagement(
        tx,
        value.engagementId,
        members.map((m) => m.participantId),
        reason,
        actor.accountId,
      );
      return {
        resultRef: value.engagementId,
        events: [
          {
            type: 'work.engagement_closed.v1',
            aggregateId: value.engagementId,
            aggregateVersion: e.revision + 1,
            guildId: e.guildId,
            payload: { engagementId: value.engagementId },
          },
        ],
      };
    },
  );
  await currentActor(tx, actor, locks);
  const result = CloseResultSchema.parse({
    status: receipt.status,
    closure: await readClosure(tx, receipt.resultRef),
  });
  await session(tx, actor);
  return result;
}
/** The member's own view of a closed engagement: closure facts plus the preserved, still-unsettled claims. */
export async function readOwnEngagementClosure(
  tx: Tx,
  actor: WorkCommand['actor'],
  engagementId: string,
) {
  validate(tx, actor);
  if (!/^[0-9a-f-]{36}$/.test(String(engagementId))) fail('INVALID_INPUT');
  const auth = await currentHuman(tx, actor);
  const rows = await tx.query<{ acceptedTerms: unknown }>(
    'SELECT e."acceptedTerms" FROM "Engagement" e JOIN "EngagementMember" m ON m."engagementId"=e."id" JOIN "EngagementClosure" c ON c."engagementId"=e."id" WHERE e."id"=$1::uuid AND m."participantId"=$2::uuid',
    [engagementId, auth.participantId],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  const terms = TermsSnapshotSchema.safeParse(rows[0].acceptedTerms);
  if (!terms.success) fail('STORAGE_CONTRACT');
  const result = OwnClosureSchema.parse({
    closure: await readClosure(tx, engagementId),
    claims: terms.data.rewards.map((r) => ({
      policy: r.policy,
      amount: r.amount,
      beneficiaryParticipantId: r.beneficiaryParticipantId,
      status: 'UNSETTLED',
    })),
  });
  await currentHuman(tx, actor, auth.locks);
  return result;
}
