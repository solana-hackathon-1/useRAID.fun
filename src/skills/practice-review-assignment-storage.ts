import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import {
  executeIdempotentCommand,
  CommandReceiptError,
  canonicalRequestDigest,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import {
  lockSkillStorageActor,
  SkillTaxonomyActorSchema,
  SkillTaxonomyStorageError,
  type SkillTaxonomyActor,
} from './taxonomy-storage';
import { PracticeTrialDefinitionSchema } from './practice-trial-contracts';
const Timestamp = UtcTimestamp.refine(
  (s) => !s.match(/\.(\d+)Z$/)?.[1] || s.match(/\.(\d+)Z$/)![1].length <= 3,
);
const Reason = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (s) =>
      s.length <= 2000 &&
      !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s),
  );
export const PracticeReviewPurposeSchema = z.enum(['OWNERSHIP_REVIEW', 'ASSESSMENT_REVIEW']);
export const IssuePracticeReviewAssignmentInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    submissionId: z.uuid(),
    evaluatorAccountId: InternalId,
    purpose: PracticeReviewPurposeSchema,
    expiresAt: Timestamp,
    reason: Reason,
  })
  .readonly();
export const RevokePracticeReviewAssignmentInputSchema = z
  .strictObject({ version: z.literal('v1'), assignmentId: z.uuid(), reason: Reason })
  .readonly();
const UseInput = z
  .strictObject({
    assignmentId: z.uuid(),
    submissionId: z.uuid(),
    purpose: PracticeReviewPurposeSchema,
  })
  .readonly();
export const PracticeReviewAssignmentRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    submissionId: z.uuid(),
    evaluatorAccountId: InternalId,
    purpose: PracticeReviewPurposeSchema,
    expiresAt: Timestamp,
    issuedAt: Timestamp,
    issuedByAccountId: InternalId,
    reason: Reason,
    state: z.literal('ISSUED'),
    isAuthorizationToken: z.literal(false),
  })
  .readonly();
export const PracticeReviewRevocationRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    assignmentId: z.uuid(),
    revokedAt: Timestamp,
    revokedByAccountId: InternalId,
    reason: Reason,
    state: z.literal('REVOKED'),
    isAuthorizationToken: z.literal(false),
  })
  .readonly();
export type PracticeReviewAssignmentRecord = z.output<typeof PracticeReviewAssignmentRecordSchema>;
export type PracticeReviewRevocationRecord = z.output<typeof PracticeReviewRevocationRecordSchema>;
export interface PracticeReviewAssignmentScope {
  readonly expiresAt: string;
  readonly issuerAccountId: string;
  readonly xId: string;
  readonly submissionId: string;
  readonly subjectAccountId: string;
  readonly participantId: string;
  readonly evaluatorAccountId: string;
  readonly skillId: string;
  readonly skillDomain: string;
  readonly purpose: z.output<typeof PracticeReviewPurposeSchema>;
}
export type PracticeReviewAssignmentUseScope = Readonly<Omit<PracticeReviewAssignmentScope, 'xId'>>;
export interface PracticeReviewAssignmentOptions {
  readonly allowNewWrites: boolean;
  readonly canManage: (scope: PracticeReviewAssignmentScope) => boolean;
}
export interface PracticeReviewAssignmentCommand {
  readonly actor: SkillTaxonomyActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export class PracticeReviewAssignmentError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'SELF_REVIEW_FORBIDDEN'
      | 'RESOURCE_UNAVAILABLE'
      | 'EXPIRY_INVALID'
      | 'ALREADY_REVOKED'
      | 'WRITES_DISABLED'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PracticeReviewAssignmentError';
  }
}
function fail(code: PracticeReviewAssignmentError['code']): never {
  throw new PracticeReviewAssignmentError(code);
}
function actorValid(value: unknown) {
  const r = SkillTaxonomyActorSchema.safeParse(value);
  if (!r.success) fail('INVALID_INPUT');
  return r.data;
}
async function query<R>(
  tx: CommandReceiptTransaction,
  sql: string,
  bindings: readonly SqlBinding[],
): Promise<R[]> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  try {
    const rows = await tx.query<R>(sql, bindings);
    if (!Array.isArray(rows)) fail('STORAGE_CONTRACT');
    return rows;
  } catch (e) {
    if (e instanceof CommandReceiptError || e instanceof PracticeReviewAssignmentError) throw e;
    return fail('STORAGE_UNAVAILABLE');
  }
}
async function authorize(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  policy?: (scope: { accountId: string; xId: string }) => boolean,
) {
  try {
    await lockSkillStorageActor(tx, actor, policy);
  } catch (e) {
    if (e instanceof SkillTaxonomyStorageError) fail(e.code);
    throw e;
  }
}
// Nonlocking authentication preflight prevents target enumeration before sorted multi-user locks.
// Current authority is checked again under the held User/Session locks before every operation.
async function preflightManagement(tx: CommandReceiptTransaction, actor: SkillTaxonomyActor) {
  const users = await query<{ suspended: boolean; role: string; xId: string | null }>(
    tx,
    'SELECT "suspended","role","xId" FROM "User" WHERE "id"=$1',
    [actor.accountId],
  );
  if (users.length !== 1) fail('AUTHENTICATION_REQUIRED');
  if (users[0].suspended !== false) fail('ACCOUNT_RESTRICTED');
  const sessions = await query<{ via: string }>(
    tx,
    `SELECT "via" FROM "Session" WHERE "tokenHash"=$1 AND "userId"=$2 AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')`,
    [actor.sessionHash, actor.accountId],
  );
  if (sessions.length !== 1 || !['x', 'wallet'].includes(sessions[0].via))
    fail('AUTHENTICATION_REQUIRED');
  if (sessions[0].via !== 'x' || users[0].role !== 'ADMIN' || !users[0].xId) fail('FORBIDDEN');
}
function allowed<T>(policy: (scope: T) => boolean, scope: T) {
  try {
    return policy(Object.freeze(scope)) === true;
  } catch {
    fail('STORAGE_UNAVAILABLE');
  }
}
async function scopeFor(
  tx: CommandReceiptTransaction,
  submissionId: string,
  evaluatorAccountId: string,
  purpose: PracticeReviewAssignmentUseScope['purpose'],
  issuerAccountId: string,
  expiresAt: string,
): Promise<PracticeReviewAssignmentUseScope> {
  const rows = await query<{ accountId: string; participantId: string; definition: unknown }>(
    tx,
    `SELECT s."accountId",s."participantId"::text,d."definition" FROM "PracticeTrialSubmission" s JOIN "PracticeTrialStart" a ON a."id"=s."startId" JOIN "PracticeTrialVersion" d ON d."id"=a."definitionVersionId" JOIN "Participant" p ON p."id"=s."participantId" AND p."accountId"=s."accountId" AND p."kind"='HUMAN' WHERE s."id"=$1::uuid`,
    [submissionId],
  );
  if (rows.length !== 1) fail(rows.length ? 'STORAGE_CONTRACT' : 'RESOURCE_UNAVAILABLE');
  const r = rows[0],
    d = PracticeTrialDefinitionSchema.safeParse(r.definition);
  if (!d.success || canonicalRequestDigest(d.data) !== canonicalRequestDigest(r.definition))
    fail('STORAGE_CONTRACT');
  return Object.freeze({
    issuerAccountId,
    expiresAt,
    submissionId,
    subjectAccountId: r.accountId,
    participantId: r.participantId,
    evaluatorAccountId,
    skillId: d.data.skillId,
    skillDomain: d.data.skillDomain,
    purpose,
  });
}
async function manage(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  scope: PracticeReviewAssignmentUseScope,
  policy: PracticeReviewAssignmentOptions['canManage'],
  newIssue = false,
) {
  // Every operation involving multiple users acquires all user rows in stable ID order first.
  await authorize(tx, actor, () => true);
  if (scope.evaluatorAccountId === scope.subjectAccountId) fail('SELF_REVIEW_FORBIDDEN');
  if (newIssue) {
    const target = await query<{ suspended: boolean }>(
      tx,
      'SELECT "suspended" FROM "User" WHERE "id"=$1',
      [scope.evaluatorAccountId],
    );
    if (target.length !== 1 || target[0].suspended !== false) fail('RESOURCE_UNAVAILABLE');
  }
  await authorize(tx, actor, ({ xId }) =>
    allowed(policy, { ...scope, issuerAccountId: actor.accountId, xId }),
  );
}
async function lockUsers(tx: CommandReceiptTransaction, ids: readonly string[]) {
  await query(
    tx,
    'SELECT "id" FROM "User" WHERE "id" IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY "id" FOR NO KEY UPDATE',
    [JSON.stringify([...new Set(ids)])],
  );
}
async function loadAssignment(
  tx: CommandReceiptTransaction,
  id: string,
): Promise<PracticeReviewAssignmentRecord | null> {
  const rows = await query<{
    id: string;
    submissionId: string;
    evaluatorAccountId: string;
    purpose: string;
    expiresAt: Date;
    issuedAt: Date;
    issuedByAccountId: string;
    reason: string;
  }>(
    tx,
    'SELECT "id"::text,"submissionId"::text,"evaluatorAccountId","purpose","expiresAt","issuedAt","issuedByAccountId","reason" FROM "PracticeTrialReviewAssignment" WHERE "id"=$1::uuid',
    [id],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  if (!rows.length) return null;
  const r = rows[0];
  if (!(r.expiresAt instanceof Date) || !(r.issuedAt instanceof Date)) fail('STORAGE_CONTRACT');
  const p = PracticeReviewAssignmentRecordSchema.safeParse({
    ...r,
    expiresAt: r.expiresAt.toISOString(),
    issuedAt: r.issuedAt.toISOString(),
    version: 'v1',
    state: 'ISSUED',
    isAuthorizationToken: false,
  });
  if (!p.success) fail('STORAGE_CONTRACT');
  return p.data;
}
async function loadRevocation(tx: CommandReceiptTransaction, id: string) {
  const rows = await query<{
    id: string;
    assignmentId: string;
    revokedAt: Date;
    revokedByAccountId: string;
    reason: string;
  }>(
    tx,
    'SELECT "id"::text,"assignmentId"::text,"revokedAt","revokedByAccountId","reason" FROM "PracticeTrialReviewRevocation" WHERE "id"=$1::uuid',
    [id],
  );
  if (rows.length !== 1 || !(rows[0].revokedAt instanceof Date)) fail('STORAGE_CONTRACT');
  const p = PracticeReviewRevocationRecordSchema.safeParse({
    ...rows[0],
    revokedAt: rows[0].revokedAt.toISOString(),
    version: 'v1',
    state: 'REVOKED',
    isAuthorizationToken: false,
  });
  if (!p.success) fail('STORAGE_CONTRACT');
  return p.data;
}
function optionsValid(options: PracticeReviewAssignmentOptions) {
  if (typeof options?.allowNewWrites !== 'boolean' || typeof options?.canManage !== 'function')
    fail('STORAGE_CONTRACT');
}
async function managementFor(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  submissionId: string,
  evaluatorAccountId: string,
  purpose: PracticeReviewAssignmentUseScope['purpose'],
  expiresAt: string,
  options: PracticeReviewAssignmentOptions,
  newIssue = false,
) {
  const scope = await scopeFor(
    tx,
    submissionId,
    evaluatorAccountId,
    purpose,
    actor.accountId,
    expiresAt,
  );
  await lockUsers(tx, [actor.accountId, scope.subjectAccountId, evaluatorAccountId]);
  await manage(tx, actor, scope, options.canManage, newIssue);
  return scope;
}
/** Immutable appointment, not a current authorization token. Original receipts survive expiry/revocation. */
export async function issuePracticeReviewAssignment(
  tx: CommandReceiptTransaction,
  command: PracticeReviewAssignmentCommand,
  options: PracticeReviewAssignmentOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; assignment: PracticeReviewAssignmentRecord }> {
  const actor = actorValid(command?.actor);
  optionsValid(options);
  const p = IssuePracticeReviewAssignmentInputSchema.safeParse(command.input);
  if (!p.success) fail('INVALID_INPUT');
  const input = p.data;
  await preflightManagement(tx, actor);
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'IssuePracticeReviewAssignment',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      await managementFor(
        tx,
        actor,
        input.submissionId,
        input.evaluatorAccountId,
        input.purpose,
        input.expiresAt,
        options,
        true,
      );
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      const clock = await query<{ valid: boolean }>(
        tx,
        'SELECT $1::timestamptz>clock_timestamp() AS valid',
        [input.expiresAt],
      );
      if (clock.length !== 1 || clock[0].valid !== true) fail('EXPIRY_INVALID');
      const rows = await query<{ id: string }>(
        tx,
        'INSERT INTO "PracticeTrialReviewAssignment"("submissionId","evaluatorAccountId","purpose","expiresAt","reason","issuedByAccountId","receiptId","requestId") VALUES($1::uuid,$2,$3,$4::timestamptz,$5,$6,$7::uuid,$8) RETURNING "id"::text',
        [
          input.submissionId,
          input.evaluatorAccountId,
          input.purpose,
          input.expiresAt,
          input.reason,
          actor.accountId,
          receiptId,
          command.requestId,
        ],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      await managementFor(
        tx,
        actor,
        input.submissionId,
        input.evaluatorAccountId,
        input.purpose,
        input.expiresAt,
        options,
        true,
      );
      return {
        resultRef: rows[0].id,
        events: [
          {
            type: 'skill.practice_review_assignment_issued.v1',
            aggregateId: rows[0].id,
            aggregateVersion: 1,
            payload: { practiceReviewAssignmentId: rows[0].id },
            publish: false,
          },
        ],
      };
    },
  );
  const assignment = await loadAssignment(tx, result.resultRef);
  if (!assignment) fail('STORAGE_CONTRACT');
  await managementFor(
    tx,
    actor,
    assignment.submissionId,
    assignment.evaluatorAccountId,
    assignment.purpose,
    assignment.expiresAt,
    options,
  );
  return { status: result.status, assignment };
}
/** Revocation is a separate immutable fact; unknown successful operations retry their original key. */
export async function revokePracticeReviewAssignment(
  tx: CommandReceiptTransaction,
  command: PracticeReviewAssignmentCommand,
  options: PracticeReviewAssignmentOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; revocation: PracticeReviewRevocationRecord }> {
  const actor = actorValid(command?.actor);
  optionsValid(options);
  const p = RevokePracticeReviewAssignmentInputSchema.safeParse(command.input);
  if (!p.success) fail('INVALID_INPUT');
  const input = p.data;
  await preflightManagement(tx, actor);
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RevokePracticeReviewAssignment',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      const g = await loadAssignment(tx, input.assignmentId);
      if (!g) fail('RESOURCE_UNAVAILABLE');
      await managementFor(
        tx,
        actor,
        g.submissionId,
        g.evaluatorAccountId,
        g.purpose,
        g.expiresAt,
        options,
      );
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12017))::text', [g.id]);
      if (
        (
          await query(
            tx,
            'SELECT "id" FROM "PracticeTrialReviewRevocation" WHERE "assignmentId"=$1::uuid',
            [g.id],
          )
        ).length
      )
        fail('ALREADY_REVOKED');
      const rows = await query<{ id: string }>(
        tx,
        'INSERT INTO "PracticeTrialReviewRevocation"("assignmentId","reason","revokedByAccountId","receiptId","requestId") VALUES($1::uuid,$2,$3,$4::uuid,$5) RETURNING "id"::text',
        [g.id, input.reason, actor.accountId, receiptId, command.requestId],
      );
      if (rows.length !== 1) fail('STORAGE_CONTRACT');
      await managementFor(
        tx,
        actor,
        g.submissionId,
        g.evaluatorAccountId,
        g.purpose,
        g.expiresAt,
        options,
      );
      return {
        resultRef: rows[0].id,
        events: [
          {
            type: 'skill.practice_review_assignment_revoked.v1',
            aggregateId: g.id,
            aggregateVersion: 1,
            payload: { practiceReviewRevocationId: rows[0].id },
            publish: false,
          },
        ],
      };
    },
  );
  const revocation = await loadRevocation(tx, result.resultRef),
    g = await loadAssignment(tx, revocation.assignmentId);
  if (!g) fail('STORAGE_CONTRACT');
  await managementFor(
    tx,
    actor,
    g.submissionId,
    g.evaluatorAccountId,
    g.purpose,
    g.expiresAt,
    options,
  );
  return { status: result.status, revocation };
}
/** Use only inside the same held transaction as the protected operation; returned DTO is not a token. */
export async function lockPracticeReviewAssignment(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  scopeValue: z.input<typeof UseInput>,
  canUse: (scope: PracticeReviewAssignmentUseScope) => boolean,
): Promise<PracticeReviewAssignmentRecord | null> {
  const actor = actorValid(actorValue),
    p = UseInput.safeParse(scopeValue);
  if (!p.success) fail('INVALID_INPUT');
  if (typeof canUse !== 'function') fail('STORAGE_CONTRACT');
  await authorize(tx, actor);
  await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12017))::text', [
    p.data.assignmentId,
  ]);
  const g = await loadAssignment(tx, p.data.assignmentId);
  await authorize(tx, actor);
  if (
    !g ||
    g.evaluatorAccountId !== actor.accountId ||
    g.submissionId !== p.data.submissionId ||
    g.purpose !== p.data.purpose
  )
    return null;
  const scope = await scopeFor(
    tx,
    g.submissionId,
    g.evaluatorAccountId,
    g.purpose,
    g.issuedByAccountId,
    g.expiresAt,
  );
  if (scope.subjectAccountId === actor.accountId) return null;
  if (!allowed(canUse, scope)) return null;
  const rows = await query<{ valid: boolean }>(
    tx,
    'SELECT "expiresAt">clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "PracticeTrialReviewRevocation" r WHERE r."assignmentId"=g."id") AS valid FROM "PracticeTrialReviewAssignment" g WHERE g."id"=$1::uuid',
    [g.id],
  );
  await authorize(tx, actor);
  if (!allowed(canUse, scope) || rows.length !== 1 || rows[0].valid !== true) return null;
  // Authority may have expired while a host session check waited; use the DB clock again last.
  const current = await query<{ valid: boolean }>(
    tx,
    'SELECT "expiresAt">clock_timestamp() AS valid FROM "PracticeTrialReviewAssignment" WHERE "id"=$1::uuid',
    [g.id],
  );
  return current.length === 1 && current[0].valid === true ? g : null;
}
