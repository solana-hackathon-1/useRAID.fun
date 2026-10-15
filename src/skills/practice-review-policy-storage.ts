import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import { SkillRankSchema } from '../contracts/entities';
import { SkillVersionReferenceSchema } from './contracts';
import {
  PracticeTrialDefinitionSchema,
  type PracticeTrialDefinition,
} from './practice-trial-contracts';
import {
  SkillTaxonomyActorSchema,
  lockSkillStorageActor,
  SkillTaxonomyStorageError,
  type SkillTaxonomyActor,
} from './taxonomy-storage';
import {
  PracticeReviewPurposeSchema,
  lockPracticeReviewAssignment,
  PracticeReviewAssignmentError,
} from './practice-review-assignment-storage';
import {
  executeIdempotentCommand,
  canonicalRequestDigest,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
const Reference = SkillVersionReferenceSchema.unwrap()
  .extend({ revision: z.number().int().min(1).max(2147483647) })
  .readonly();
const Guidance = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .refine(
    (s) =>
      s.length <= 4000 &&
      !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s),
  );
export const PublishPracticeReviewPolicyInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    policyId: InternalId,
    expectedRevision: z.number().int().min(0).max(2147483646),
    definitionReference: Reference,
    purpose: PracticeReviewPurposeSchema,
    state: z.enum(['APPROVED', 'WITHDRAWN']),
    guidance: Guidance,
  })
  .readonly();
export const UsePracticeReviewPolicyInputSchema = z
  .strictObject({
    version: z.literal('v1'),
    assignmentId: z.uuid(),
    submissionId: z.uuid(),
    purpose: PracticeReviewPurposeSchema,
    expectedPolicyReference: Reference,
  })
  .readonly();
export const ObservePracticeReviewPolicyInputSchema = UsePracticeReviewPolicyInputSchema.unwrap()
  .omit({ expectedPolicyReference: true })
  .readonly();
export const PracticeReviewPolicyRecordSchema = z
  .strictObject({
    version: z.literal('v1'),
    id: z.uuid(),
    reference: Reference,
    definitionReference: Reference,
    rubricReference: Reference,
    skillId: InternalId,
    skillDomain: InternalId,
    targetRank: SkillRankSchema,
    purpose: PracticeReviewPurposeSchema,
    state: z.enum(['APPROVED', 'WITHDRAWN']),
    guidance: Guidance,
    publishedByAccountId: InternalId,
    publishedAt: UtcTimestamp,
    persisted: z.literal(true),
    verifiesSkill: z.literal(false),
    confirmsOwnership: z.literal(false),
    createsPermissionGrant: z.literal(false),
    isAuthorizationToken: z.literal(false),
    consumesCapacity: z.literal(false),
    createsFinancialObligation: z.literal(false),
  })
  .readonly();
export const PracticeReviewPolicyViewSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    policy: PracticeReviewPolicyRecordSchema,
    accessId: z.uuid(),
    isAuthorizationToken: z.literal(false),
  })
  .readonly();
export type PracticeReviewPolicyRecord = z.output<typeof PracticeReviewPolicyRecordSchema>;
export type PracticeReviewPolicyView = z.output<typeof PracticeReviewPolicyViewSchema>;
export interface PracticeReviewPolicyScope {
  readonly accountId: string;
  readonly xId: string;
  readonly policyId: string;
  readonly definitionReference: Readonly<{ recordId: string; revision: number }>;
  readonly rubricReference: Readonly<{ recordId: string; revision: number }>;
  readonly skillId: string;
  readonly skillDomain: string;
  readonly targetRank: string;
  readonly purpose: 'OWNERSHIP_REVIEW' | 'ASSESSMENT_REVIEW';
}
export interface PracticeReviewPolicyUseScope {
  readonly actorAccountId: string;
  readonly assignmentId: string;
  readonly submissionId: string;
  readonly policyReference: Readonly<{ recordId: string; revision: number }>;
  readonly policyVersionId: string;
  readonly definitionReference: Readonly<{ recordId: string; revision: number }>;
  readonly skillId: string;
  readonly skillDomain: string;
  readonly purpose: 'OWNERSHIP_REVIEW' | 'ASSESSMENT_REVIEW';
}
export interface PracticeReviewPolicyOptions {
  readonly allowNewWrites: boolean;
  readonly canPublish: (scope: PracticeReviewPolicyScope) => boolean;
}
export interface PublishPracticeReviewPolicyCommand {
  readonly actor: SkillTaxonomyActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export class PracticeReviewPolicyError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'FORBIDDEN'
      | 'RESOURCE_UNAVAILABLE'
      | 'WRITES_DISABLED'
      | 'REVISION_CHANGED'
      | 'FAMILY_CHANGED'
      | 'POLICY_SCOPE_EXISTS'
      | 'INITIAL_STATE_INVALID'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PracticeReviewPolicyError';
  }
}
function fail(code: PracticeReviewPolicyError['code']): never {
  throw new PracticeReviewPolicyError(code);
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
  } catch (error) {
    if (error instanceof CommandReceiptError || error instanceof PracticeReviewPolicyError)
      throw error;
    return fail('STORAGE_UNAVAILABLE');
  }
}
function allowed<T>(check: (value: T) => boolean, value: T) {
  try {
    return check(Object.freeze(value)) === true;
  } catch {
    fail('STORAGE_UNAVAILABLE');
  }
}
function normalize(error: unknown): never {
  if (
    error instanceof SkillTaxonomyStorageError ||
    error instanceof PracticeReviewAssignmentError
  ) {
    switch (error.code) {
      case 'INVALID_INPUT':
      case 'AUTHENTICATION_REQUIRED':
      case 'ACCOUNT_RESTRICTED':
      case 'FORBIDDEN':
      case 'RESOURCE_UNAVAILABLE':
      case 'STORAGE_CONTRACT':
      case 'STORAGE_UNAVAILABLE':
        fail(error.code);
      default:
        fail('STORAGE_CONTRACT');
    }
  }
  if (error instanceof CommandReceiptError || error instanceof PracticeReviewPolicyError)
    throw error;
  return fail('STORAGE_UNAVAILABLE');
}
async function admin(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  policy: (value: { accountId: string; xId: string }) => boolean,
) {
  try {
    await lockSkillStorageActor(tx, actor, policy);
  } catch (error) {
    normalize(error);
  }
}
type Purpose = z.output<typeof PracticeReviewPurposeSchema>;
type Definition = { id: string; definition: PracticeTrialDefinition };
async function definition(
  tx: CommandReceiptTransaction,
  where: string,
  bindings: readonly SqlBinding[],
): Promise<Definition> {
  const rows = await query<{ id: string; definition: unknown }>(
    tx,
    'SELECT "id"::text,"definition" FROM "PracticeTrialVersion" WHERE ' + where,
    bindings,
  );
  if (rows.length !== 1) fail(rows.length ? 'STORAGE_CONTRACT' : 'RESOURCE_UNAVAILABLE');
  const d = PracticeTrialDefinitionSchema.safeParse(rows[0].definition);
  if (!d.success || canonicalRequestDigest(d.data) !== canonicalRequestDigest(rows[0].definition))
    fail('STORAGE_CONTRACT');
  return { id: rows[0].id, definition: d.data };
}
function pubScope(
  d: Definition,
  id: string,
  purpose: Purpose,
  actor: { accountId: string; xId: string },
): PracticeReviewPolicyScope {
  return Object.freeze({
    ...actor,
    policyId: id,
    definitionReference: d.definition.reference,
    rubricReference: d.definition.rubric.reference,
    skillId: d.definition.skillId,
    skillDomain: d.definition.skillDomain,
    targetRank: d.definition.targetRank,
    purpose,
  });
}
const scopeKey = (id: string, purpose: Purpose) => id + ':' + purpose;
async function lockScope(tx: CommandReceiptTransaction, id: string, purpose: Purpose) {
  await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12019))::text', [
    scopeKey(id, purpose),
  ]);
}
type Family = {
  id: string;
  definitionVersionId: string;
  purpose: Purpose;
  revision: number;
  currentVersionId: string;
};
async function family(
  tx: CommandReceiptTransaction,
  where: string,
  bindings: readonly SqlBinding[],
): Promise<Family | null> {
  const rows = await query<Family>(
    tx,
    'SELECT "id","definitionVersionId"::text,"purpose","revision","currentVersionId"::text FROM "PracticeReviewPolicy" WHERE ' +
      where,
    bindings,
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  return rows[0] ?? null;
}
type Meta = {
  id: string;
  policyId: string;
  definitionVersionId: string;
  purpose: Purpose;
  revision: number;
  state: 'APPROVED' | 'WITHDRAWN';
  publishedByAccountId: string;
  publishedAt: Date;
};
async function meta(
  tx: CommandReceiptTransaction,
  where: string,
  bindings: readonly SqlBinding[],
): Promise<Meta | null> {
  const rows = await query<Meta>(
    tx,
    'SELECT "id"::text,"policyId","definitionVersionId"::text,"purpose","revision","state","publishedByAccountId","publishedAt" FROM "PracticeReviewPolicyVersion" WHERE ' +
      where,
    bindings,
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  if (!rows.length) return null;
  const r = rows[0];
  if (
    !z.uuid().safeParse(r.id).success ||
    !InternalId.safeParse(r.policyId).success ||
    !Reference.safeParse({ recordId: r.policyId, revision: r.revision }).success ||
    !PracticeReviewPurposeSchema.safeParse(r.purpose).success ||
    !['APPROVED', 'WITHDRAWN'].includes(r.state) ||
    !(r.publishedAt instanceof Date) ||
    Number.isNaN(r.publishedAt.getTime())
  )
    fail('STORAGE_CONTRACT');
  return r;
}
async function accessAudit(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  m: Meta,
  kind: string,
  eventType: string,
  aggregateId: string,
  aggregateVersion: number,
  request: unknown,
) {
  const rows = await query<{ id: string }>(tx, 'SELECT gen_random_uuid()::text AS id', []);
  if (rows.length !== 1 || !z.uuid().safeParse(rows[0].id).success) fail('STORAGE_CONTRACT');
  const id = rows[0].id;
  await executeIdempotentCommand(
    tx,
    { actorId: actor.accountId, commandKind: kind, idempotencyKey: id, requestId: id, request },
    async () => ({
      resultRef: m.id,
      events: [
        {
          type: eventType,
          aggregateId,
          aggregateVersion,
          payload: { practiceReviewPolicyVersionId: m.id },
          publish: false,
        },
      ],
    }),
  );
  return id;
}
async function loadGuide(
  tx: CommandReceiptTransaction,
  m: Meta,
  d: Definition,
): Promise<PracticeReviewPolicyRecord> {
  const rows = await query<{ guidance: string }>(
    tx,
    'SELECT "guidance" FROM "PracticeReviewPolicyVersion" WHERE "id"=$1::uuid',
    [m.id],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const r = PracticeReviewPolicyRecordSchema.safeParse({
    version: 'v1',
    id: m.id,
    reference: { recordId: m.policyId, revision: m.revision },
    definitionReference: d.definition.reference,
    rubricReference: d.definition.rubric.reference,
    skillId: d.definition.skillId,
    skillDomain: d.definition.skillDomain,
    targetRank: d.definition.targetRank,
    purpose: m.purpose,
    state: m.state,
    guidance: rows[0].guidance,
    publishedByAccountId: m.publishedByAccountId,
    publishedAt: m.publishedAt.toISOString(),
    persisted: true,
    verifiesSkill: false,
    confirmsOwnership: false,
    createsPermissionGrant: false,
    isAuthorizationToken: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  });
  if (!r.success || r.data.guidance !== rows[0].guidance || m.definitionVersionId !== d.id)
    fail('STORAGE_CONTRACT');
  return r.data;
}
async function adminVersion(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  m: Meta,
  canPublish: PracticeReviewPolicyOptions['canPublish'],
): Promise<PracticeReviewPolicyView | null> {
  const d = await definition(tx, '"id"=$1::uuid', [m.definitionVersionId]);
  await lockScope(tx, d.id, m.purpose);
  let authorized = false;
  await admin(tx, actor, (a) => {
    authorized = allowed(canPublish, pubScope(d, m.policyId, m.purpose, a));
    return true;
  });
  if (!authorized) return null;
  const accessId = await accessAudit(
    tx,
    actor,
    m,
    'ReadPracticeReviewPolicyVersion',
    'skill.practice_review_policy_access_authorized.v1',
    m.policyId,
    m.revision,
    { version: 'v1', policyReference: { recordId: m.policyId, revision: m.revision } },
  );
  await admin(tx, actor, (a) => allowed(canPublish, pubScope(d, m.policyId, m.purpose, a)));
  const policy = await loadGuide(tx, m, d);
  await admin(tx, actor, (a) => allowed(canPublish, pubScope(d, m.policyId, m.purpose, a)));
  return { version: 'v1', private: true, policy, accessId, isAuthorizationToken: false };
}
/** Actual scoped administrator approval data; no policy contents, calibration or rank is seeded. */
export async function publishPracticeReviewPolicy(
  tx: CommandReceiptTransaction,
  command: PublishPracticeReviewPolicyCommand,
  options: PracticeReviewPolicyOptions,
): Promise<{
  status: 'EXECUTED' | 'REPLAYED';
  policy: PracticeReviewPolicyRecord;
  accessId: string;
}> {
  const actor = actorValid(command?.actor);
  if (typeof options?.allowNewWrites !== 'boolean' || typeof options?.canPublish !== 'function')
    fail('STORAGE_CONTRACT');
  const parsed = PublishPracticeReviewPolicyInputSchema.safeParse(command.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'PublishPracticeReviewPolicy',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      await admin(tx, actor, () => true);
      const d = await definition(tx, '"trialId"=$1 AND "revision"=$2::int', [
        input.definitionReference.recordId,
        String(input.definitionReference.revision),
      ]);
      await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12018))::text', [
        input.policyId,
      ]);
      await lockScope(tx, d.id, input.purpose);
      await admin(tx, actor, (a) =>
        allowed(options.canPublish, pubScope(d, input.policyId, input.purpose, a)),
      );
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      const old = await family(tx, '"id"=$1', [input.policyId]);
      if (old && (old.definitionVersionId !== d.id || old.purpose !== input.purpose))
        fail('FAMILY_CHANGED');
      const canonical = await family(tx, '"definitionVersionId"=$1::uuid AND "purpose"=$2', [
        d.id,
        input.purpose,
      ]);
      if (canonical && canonical.id !== input.policyId) fail('POLICY_SCOPE_EXISTS');
      if ((old?.revision ?? 0) !== input.expectedRevision) fail('REVISION_CHANGED');
      if (!old && input.state !== 'APPROVED') fail('INITIAL_STATE_INVALID');
      const revision = input.expectedRevision + 1;
      const rows = await query<{ id: string }>(
        tx,
        'INSERT INTO "PracticeReviewPolicyVersion"("policyId","definitionVersionId","purpose","revision","state","guidance","publishedByAccountId","receiptId","requestId") VALUES($1,$2::uuid,$3,$4::int,$5,$6,$7,$8::uuid,$9) RETURNING "id"::text',
        [
          input.policyId,
          d.id,
          input.purpose,
          String(revision),
          input.state,
          input.guidance,
          actor.accountId,
          receiptId,
          command.requestId,
        ],
      );
      if (rows.length !== 1 || !z.uuid().safeParse(rows[0].id).success) fail('STORAGE_CONTRACT');
      const pointer = await query(
        tx,
        old
          ? 'UPDATE "PracticeReviewPolicy" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1 RETURNING "id"'
          : 'INSERT INTO "PracticeReviewPolicy"("id","revision","currentVersionId","definitionVersionId","purpose") VALUES($1,$2::int,$3::uuid,$4::uuid,$5) RETURNING "id"',
        old
          ? [input.policyId, String(revision), rows[0].id]
          : [input.policyId, String(revision), rows[0].id, d.id, input.purpose],
      );
      if (pointer.length !== 1) fail('STORAGE_CONTRACT');
      await admin(tx, actor, (a) =>
        allowed(options.canPublish, pubScope(d, input.policyId, input.purpose, a)),
      );
      return {
        resultRef: rows[0].id,
        events: [
          {
            type: 'skill.practice_review_policy_published.v1',
            aggregateId: input.policyId,
            aggregateVersion: revision,
            payload: { practiceReviewPolicyVersionId: rows[0].id },
            publish: false,
          },
        ],
      };
    },
  );
  await admin(tx, actor, () => true);
  const m = await meta(tx, '"id"=$1::uuid', [result.resultRef]);
  if (!m) fail('STORAGE_CONTRACT');
  const view = await adminVersion(tx, actor, m, options.canPublish);
  if (!view) fail('FORBIDDEN');
  return { status: result.status, policy: view.policy, accessId: view.accessId };
}
/** Private scoped administration history, not a current decision authorization. */
export async function readPracticeReviewPolicyAsAdmin(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  policyId: string,
  revision: number | undefined,
  canPublish: PracticeReviewPolicyOptions['canPublish'],
): Promise<PracticeReviewPolicyView | null> {
  const actor = actorValid(actorValue);
  if (
    !InternalId.safeParse(policyId).success ||
    (revision !== undefined && !z.number().int().min(1).max(2147483647).safeParse(revision).success)
  )
    fail('INVALID_INPUT');
  if (typeof canPublish !== 'function') fail('STORAGE_CONTRACT');
  await admin(tx, actor, () => true);
  let f = await family(tx, '"id"=$1', [policyId]);
  if (!f) return null;
  await lockScope(tx, f.definitionVersionId, f.purpose);
  f = await family(tx, '"id"=$1', [policyId]);
  if (!f) fail('STORAGE_CONTRACT');
  const m = await meta(tx, '"policyId"=$1 AND "revision"=$2::int', [
    policyId,
    String(revision ?? f.revision),
  ]);
  if (!m) return null;
  return adminVersion(tx, actor, m, canPublish);
}
/** Hold this same transaction through the later decision; the returned snapshot is never a token. */
async function resolveApprovedPolicy(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  input: z.output<typeof ObservePracticeReviewPolicyInputSchema>,
  expected: Readonly<{ recordId: string; revision: number }> | null,
  canUse: (scope: PracticeReviewPolicyUseScope) => boolean,
): Promise<PracticeReviewPolicyView | null> {
  const actor = actorValid(actorValue);
  if (typeof canUse !== 'function') fail('STORAGE_CONTRACT');
  const permission = async () => {
    try {
      return await lockPracticeReviewAssignment(
        tx,
        actor,
        {
          assignmentId: input.assignmentId,
          submissionId: input.submissionId,
          purpose: input.purpose,
        },
        () => true,
      );
    } catch (error) {
      return normalize(error);
    }
  };
  if (!(await permission())) return null;
  const submissions = await query<{ definitionVersionId: string }>(
    tx,
    'SELECT a."definitionVersionId"::text FROM "PracticeTrialSubmission" s JOIN "PracticeTrialStart" a ON a."id"=s."startId" WHERE s."id"=$1::uuid',
    [input.submissionId],
  );
  if (submissions.length !== 1) fail('STORAGE_CONTRACT');
  const d = await definition(tx, '"id"=$1::uuid', [submissions[0].definitionVersionId]);
  await lockScope(tx, d.id, input.purpose);
  // The case grant may expire while policy publication holds the canonical source lock.
  if (!(await permission())) return null;
  const f = await family(tx, '"definitionVersionId"=$1::uuid AND "purpose"=$2', [
    d.id,
    input.purpose,
  ]);
  if (!f) return null;
  if (expected && (f.id !== expected.recordId || f.revision !== expected.revision))
    fail('REVISION_CHANGED');
  const m = await meta(tx, '"id"=$1::uuid', [f.currentVersionId]);
  if (
    !m ||
    m.policyId !== f.id ||
    m.revision !== f.revision ||
    m.definitionVersionId !== d.id ||
    m.purpose !== input.purpose
  )
    fail('STORAGE_CONTRACT');
  if (m.state !== 'APPROVED') return null;
  const scope: PracticeReviewPolicyUseScope = Object.freeze({
    actorAccountId: actor.accountId,
    assignmentId: input.assignmentId,
    submissionId: input.submissionId,
    policyReference: { recordId: m.policyId, revision: m.revision },
    policyVersionId: m.id,
    definitionReference: d.definition.reference,
    skillId: d.definition.skillId,
    skillDomain: d.definition.skillDomain,
    purpose: input.purpose,
  });
  if (!allowed(canUse, scope)) return null;
  const accessId = await accessAudit(
    tx,
    actor,
    m,
    'ReadApprovedPracticeReviewPolicy',
    'skill.practice_review_policy_use_authorized.v1',
    input.submissionId,
    1,
    input,
  );
  if (!(await permission()) || !allowed(canUse, scope)) return null;
  const policy = await loadGuide(tx, m, d);
  if (!(await permission()) || !allowed(canUse, scope)) return null;
  return { version: 'v1', private: true, policy, accessId, isAuthorizationToken: false };
}

/** Exact expected current source is mandatory when the caller will commit a later decision. */
export async function lockApprovedPracticeReviewPolicy(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  inputValue: unknown,
  canUse: (scope: PracticeReviewPolicyUseScope) => boolean,
): Promise<PracticeReviewPolicyView | null> {
  const input = UsePracticeReviewPolicyInputSchema.safeParse(inputValue);
  if (!input.success) fail('INVALID_INPUT');
  return resolveApprovedPolicy(tx, actor, input.data, input.data.expectedPolicyReference, canUse);
}
/** Initial current observation derives its canonical source from the actual case, never a label. */
export async function observeApprovedPracticeReviewPolicy(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  inputValue: unknown,
  canUse: (scope: PracticeReviewPolicyUseScope) => boolean,
): Promise<PracticeReviewPolicyView | null> {
  const input = ObservePracticeReviewPolicyInputSchema.safeParse(inputValue);
  if (!input.success) fail('INVALID_INPUT');
  return resolveApprovedPolicy(tx, actor, input.data, null, canUse);
}
