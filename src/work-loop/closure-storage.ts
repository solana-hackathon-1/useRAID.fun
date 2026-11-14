import {
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import { TermsSnapshotSchema } from '../contracts/entities';
import type { WorkActor, WorkCommand } from './contracts';
import {
  WORK_CLOSURE_PRINCIPAL,
  CloseOverdueInput,
  CloseResultSchema,
  ClosureSchema,
  OwnClosureSchema,
  type ClosureCaller,
  type ClosureHost,
  type ServicePrincipalCommand,
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
/** Who closed: a human account, or the named service principal (never both, never neither: database CHECK). */
export type Closer = { accountId: string } | { principal: typeof WORK_CLOSURE_PRINCIPAL };
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
  closer: Closer,
) {
  const finalState = reason === 'ACCEPTED' ? 'ACCEPTED' : 'TERMINATED';
  await tx.query(
    'INSERT INTO "EngagementClosure" ("engagementId","reason","finalState","closedByAccountId","closedByPrincipal") VALUES ($1::uuid,$2,$3,$4,$5) RETURNING "engagementId"',
    [
      engagementId,
      reason,
      finalState,
      'accountId' in closer ? closer.accountId : null,
      'principal' in closer ? closer.principal : null,
    ],
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
export function closeOverdueEngagement(tx: Tx, command: WorkCommand, host: ClosureHost) {
  validate(tx, command?.actor);
  // The host and the body see only a plain account actor: any extra key on the presented object (such as `principal`)
  // is dropped here, so a caller cannot be mistaken for the service principal.
  const { accountId, sessionHash } = command.actor;
  return closeOverdue(tx, { ...command, caller: { accountId, sessionHash } }, host);
}
/**
 * The scheduled variant: the `work-closure` service principal (DEC-2026-11-14-08) closes an overdue engagement. It has
 * no Session or account to prove, so the host authorizes it (timeout closure only) and the closure records the
 * principal, not a borrowed human. Any other principal value is refused; the HTTP route never calls this.
 */
export function closeOverdueEngagementAsPrincipal(
  tx: Tx,
  command: ServicePrincipalCommand,
  host: ClosureHost,
) {
  if (command?.principal !== WORK_CLOSURE_PRINCIPAL) fail('UNAUTHENTICATED');
  return closeOverdue(
    tx,
    {
      caller: { principal: command.principal },
      input: command.input,
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
    },
    host,
  );
}
async function closeOverdue(
  tx: Tx,
  command: { caller: ClosureCaller; input: unknown; idempotencyKey: string; requestId: string },
  host: ClosureHost,
) {
  if (typeof host?.allowNewWrites !== 'boolean' || typeof host.authorize !== 'function')
    fail('STORAGE_CONTRACT');
  const parsed = CloseOverdueInput.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const value = parsed.data,
    caller = command.caller;
  // A human proves a current Session and identity locks; the principal has no identity to lock (it is not a User row).
  const human: WorkActor | null = 'accountId' in caller ? caller : null;
  const closer: Closer = human
    ? { accountId: human.accountId }
    : { principal: WORK_CLOSURE_PRINCIPAL };
  if (human) await session(tx, human);
  /** Current operations authority over this engagement, asked of the host in this transaction. */
  const authorized = async (guildId: string, engagementId: string = value.engagementId) =>
    (await host.authorize(tx, caller, { engagementId, guildId })) === true;
  let locks: Awaited<ReturnType<typeof currentActor>> | undefined;
  const receipt = await executeIdempotentCommand(
    tx,
    {
      actorId: human ? human.accountId : WORK_CLOSURE_PRINCIPAL,
      commandKind: 'CloseOverdueEngagement',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: value,
    },
    async () => {
      if (human) locks = await currentActor(tx, human);
      // Missing and unauthorized engagements are one indistinguishable denial.
      const ref = await tx.query<{ guildId: string }>(
        'SELECT "guildId" FROM "Engagement" WHERE "id"=$1::uuid',
        [value.engagementId],
      );
      if (ref.length !== 1 || !(await authorized(ref[0].guildId))) fail('FORBIDDEN');
      // After authority and before any state or revision answer: the switch is not visible without authority (#352).
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const rows = await tx.query<{ state: string; revision: number; guildId: string }>(
        'SELECT "state","revision","guildId" FROM "Engagement" WHERE "id"=$1::uuid FOR UPDATE',
        [value.engagementId],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      const e = rows[0];
      const reason = TIMEOUT_REASON[e.state];
      if (!reason) fail('ENGAGEMENT_STATE');
      if (e.revision !== value.expectedRevision) fail('REVISION_CONFLICT');
      // A separate statement after the lock: an amendment accepted while this waited takes the engagement lock without
      // writing an Engagement row, so terms read in the locking statement would come from its older snapshot.
      const effective = await tx.query<{ acceptedTerms: unknown }>(
        'SELECT raid_effective_terms("id") AS "acceptedTerms" FROM "Engagement" WHERE "id"=$1::uuid',
        [value.engagementId],
      );
      if (effective.length !== 1) fail('STORAGE_CONTRACT');
      const terms = TermsSnapshotSchema.safeParse(effective[0].acceptedTerms);
      if (!terms.success) fail('STORAGE_CONTRACT');
      if (Date.parse(terms.data.deadlines.operationalClosure) > (await clock(tx)).getTime())
        fail('DEADLINE_NOT_REACHED');
      const members = await tx.query<{ participantId: string }>(
        'SELECT "participantId"::text FROM "EngagementMember" WHERE "engagementId"=$1::uuid',
        [value.engagementId],
      );
      // Authority is proven again after the engagement lock wait.
      if (human) await currentActor(tx, human, locks);
      if (!(await authorized(e.guildId))) fail('FORBIDDEN');
      await closeEngagement(
        tx,
        value.engagementId,
        members.map((m) => m.participantId),
        reason,
        closer,
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
  if (human) await currentActor(tx, human, locks);
  // A fresh closure already proved authority after the engagement lock, in this transaction. A replayed receipt ran no
  // command body, so it is read back only while the closer still holds the authority it was made under.
  if (receipt.status === 'REPLAYED') {
    const [closed] = await tx.query<{ guildId: string }>(
      'SELECT "guildId" FROM "Engagement" WHERE "id"=$1::uuid',
      [receipt.resultRef],
    );
    if (!closed || !(await authorized(closed.guildId, receipt.resultRef))) fail('FORBIDDEN');
  }
  const result = CloseResultSchema.parse({
    status: receipt.status,
    closure: await readClosure(tx, receipt.resultRef),
  });
  if (human) await session(tx, human);
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
    'SELECT raid_effective_terms(e."id") AS "acceptedTerms" FROM "Engagement" e JOIN "EngagementMember" m ON m."engagementId"=e."id" JOIN "EngagementClosure" c ON c."engagementId"=e."id" WHERE e."id"=$1::uuid AND m."participantId"=$2::uuid',
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
