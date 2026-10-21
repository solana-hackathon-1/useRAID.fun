import {
  RecordPracticeTrialAssessmentInputSchema,
  ReadPracticeTrialAssessmentInputSchema,
  PracticeTrialAssessmentViewSchema,
  PracticeTrialAssessmentView,
  ObservePracticeTrialAssessmentContextInputSchema,
  PracticeTrialAssessmentContextSchema,
  PracticeTrialAssessmentContext,
  RecordPracticeAssessmentDecisionInputSchema,
  PracticeTrialAssessmentStateSchema,
  PracticeTrialAssessmentState,
  PracticeAssessmentDecisionViewSchema,
  PracticeAssessmentDecisionView,
  PracticeAssessmentReferenceSchema as Reference,
  PracticeAssessmentTextSchema as Text,
  PracticeAssessmentCriteriaSchema as Criteria,
} from './practice-trial-assessment-contracts';
export * from './practice-trial-assessment-contracts';
import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { SkillRankSchema } from '../contracts/entities';
import { SkillAssessmentSnapshotSchema } from './assessment-review-contracts';
import {
  PracticeTrialDefinitionSchema,
  type PracticeTrialDefinition,
} from './practice-trial-contracts';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage';
import {
  lockPracticeReviewAssignment,
  type PracticeReviewAssignmentUseScope,
} from './practice-review-assignment-storage';
import { readPracticeTrialForReview } from './practice-review-read-storage';
import {
  lockApprovedPracticeReviewPolicy,
  type PracticeReviewPolicyUseScope,
  type PracticeReviewPolicyView,
} from './practice-review-policy-storage';
import { readPracticeTrialOwnership } from './practice-trial-ownership-storage';
import {
  executeIdempotentCommand,
  canonicalRequestDigest,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
  type CommandOutcome,
} from '../command-receipts';
const same = (
  a: Readonly<{ recordId: string; revision: number }> | null,
  b: Readonly<{ recordId: string; revision: number }> | null,
) => (a === null || b === null ? a === b : a.recordId === b.recordId && a.revision === b.revision);
type SkillAssessmentSnapshot = z.output<typeof SkillAssessmentSnapshotSchema>;
export interface PracticeTrialAssessmentCommand {
  readonly actor: SkillTaxonomyActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export interface PracticeTrialAssessmentScope {
  readonly actorAccountId: string;
  readonly assignmentId: string;
  readonly submissionReference: Readonly<{ recordId: string; revision: number }>;
  readonly participantId: string;
  readonly taxonomyId: string;
  readonly taxonomyReference: Readonly<{ recordId: string; revision: number }>;
  readonly definitionReference: Readonly<{ recordId: string; revision: number }>;
  readonly rubricReference: Readonly<{ recordId: string; revision: number }>;
  readonly skillId: string;
  readonly skillDomain: string;
  readonly targetRank: string;
  readonly policyVersionId: string;
  readonly policyReference: Readonly<{ recordId: string; revision: number }>;
  readonly ownershipVersionId: string | null;
  readonly ownershipReference: Readonly<{ recordId: string; revision: number }> | null;
  readonly currentReviewReference: Readonly<{ recordId: string; revision: number }> | null;
  readonly currentAssessmentReference: Readonly<{ recordId: string; revision: number }> | null;
  readonly decision: 'VERIFY' | 'MORE_EVIDENCE' | 'NOT_DEMONSTRATED';
}
export interface PracticeTrialAssessmentOptions {
  readonly allowNewWrites: boolean;
  readonly canRead: (scope: PracticeReviewAssignmentUseScope) => boolean;
  readonly canUsePolicy: (scope: PracticeReviewPolicyUseScope) => boolean;
  readonly canReview: (scope: PracticeTrialAssessmentScope) => boolean;
}
export class PracticeTrialAssessmentError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'RESOURCE_UNAVAILABLE'
      | 'WRITES_DISABLED'
      | 'REVISION_CHANGED'
      | 'FAMILY_CHANGED'
      | 'EVIDENCE_NOT_CONFIRMED'
      | 'RUBRIC_NOT_MET'
      | 'HIGH_RANK_EVIDENCE_REQUIRED'
      | 'AUTOMATED_EVIDENCE_UNAVAILABLE'
      | 'TOOLS_POLICY_NOT_MET'
      | 'CURRENT_HIGHER_ASSESSMENT'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PracticeTrialAssessmentError';
  }
}
function fail(code: PracticeTrialAssessmentError['code']): never {
  throw new PracticeTrialAssessmentError(code);
}
function actorValid(value: unknown) {
  const p = SkillTaxonomyActorSchema.safeParse(value);
  if (!p.success) fail('INVALID_INPUT');
  return p.data;
}
function allowed<T>(fn: (v: T) => boolean, v: T) {
  try {
    return fn(Object.freeze(v)) === true;
  } catch {
    fail('STORAGE_UNAVAILABLE');
  }
}
function normalize(error: unknown): never {
  if (error instanceof PracticeTrialAssessmentError || error instanceof CommandReceiptError)
    throw error;
  const code = (error as { code?: string })?.code;
  if (
    code &&
    [
      'INVALID_INPUT',
      'AUTHENTICATION_REQUIRED',
      'ACCOUNT_RESTRICTED',
      'RESOURCE_UNAVAILABLE',
      'REVISION_CHANGED',
      'STORAGE_CONTRACT',
      'STORAGE_UNAVAILABLE',
    ].includes(code)
  )
    fail(code as PracticeTrialAssessmentError['code']);
  if (code === 'FORBIDDEN') fail('RESOURCE_UNAVAILABLE');
  fail('STORAGE_UNAVAILABLE');
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
    const r = await tx.query<R>(sql, bindings);
    if (!Array.isArray(r)) fail('STORAGE_CONTRACT');
    return r;
  } catch (e) {
    if (e instanceof PracticeTrialAssessmentError || e instanceof CommandReceiptError) throw e;
    fail('STORAGE_UNAVAILABLE');
  }
}
type ReadInput = z.output<typeof ReadPracticeTrialAssessmentInputSchema>;
function caseInput(input: ReadInput) {
  return {
    version: 'v1' as const,
    assignmentId: input.assignmentId,
    submissionId: input.submissionId,
    purpose: 'ASSESSMENT_REVIEW' as const,
  };
}
async function permission(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  input: ReadInput,
  canRead: PracticeTrialAssessmentOptions['canRead'],
) {
  try {
    let scope: PracticeReviewAssignmentUseScope | undefined;
    const grant = await lockPracticeReviewAssignment(
      tx,
      actor,
      {
        assignmentId: input.assignmentId,
        submissionId: input.submissionId,
        purpose: 'ASSESSMENT_REVIEW',
      },
      (s) => {
        scope = s;
        return allowed(canRead, s);
      },
    );
    return grant && scope && allowed(canRead, scope) ? { grant, scope } : null;
  } catch (e) {
    return normalize(e);
  }
}
async function lockCase(tx: CommandReceiptTransaction, id: string) {
  await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12020))::text', [id]);
}
async function lockSkill(tx: CommandReceiptTransaction, participantId: string, skillId: string) {
  await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12022))::text', [
    participantId + ':' + skillId,
  ]);
}
interface Family {
  id: string;
  participantId: string;
  skillId: string;
  skillDomain: string;
  taxonomyId: string;
  revision: number;
  currentVersionId: string;
  state: string;
  assessedRank: string;
}
async function family(
  tx: CommandReceiptTransaction,
  participantId: string,
  skillId: string,
): Promise<Family | null> {
  const rows = await query<Family>(
    tx,
    'SELECT p."id"::text,p."participantId"::text,p."skillId",p."skillDomain",p."taxonomyId",p."revision",p."currentVersionId"::text,v."state",v."assessedRank" FROM "SkillAssessment" p JOIN "SkillAssessmentVersion" v ON v."id"=p."currentVersionId" WHERE p."participantId"=$1::uuid AND p."skillId"=$2',
    [participantId, skillId],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  if (!rows.length) return null;
  const r = rows[0];
  if (
    !z.uuid().safeParse(r.id).success ||
    !z.uuid().safeParse(r.currentVersionId).success ||
    r.participantId !== participantId ||
    r.skillId !== skillId ||
    !Reference.safeParse({ recordId: r.id, revision: r.revision }).success ||
    !SkillRankSchema.safeParse(r.assessedRank).success ||
    !['VERIFIED', 'REASSESSMENT_REQUIRED', 'REVOKED'].includes(r.state) ||
    !InternalId.safeParse(r.taxonomyId).success ||
    !InternalId.safeParse(r.skillDomain).success
  )
    fail('STORAGE_CONTRACT');
  return r;
}
async function reviewPointer(tx: CommandReceiptTransaction, submissionId: string) {
  const rows = await query<{ revision: number; currentVersionId: string }>(
    tx,
    'SELECT "revision","currentVersionId"::text FROM "PracticeAssessmentReview" WHERE "submissionId"=$1::uuid',
    [submissionId],
  );
  if (rows.length > 1) fail('STORAGE_CONTRACT');
  if (!rows.length) return null;
  if (
    !Reference.safeParse({ recordId: submissionId, revision: rows[0].revision }).success ||
    !z.uuid().safeParse(rows[0].currentVersionId).success
  )
    fail('STORAGE_CONTRACT');
  return rows[0];
}
async function receipt(
  tx: CommandReceiptTransaction,
  actorId: string,
  kind: string,
  requestId: string,
  resultRef: string,
) {
  const r = await query<{ id: string }>(
    tx,
    'SELECT "id"::text FROM "CommandReceipt" WHERE "actorId"=$1 AND "commandKind"=$2 AND "requestId"=$3 AND "resultRef"=$4',
    [actorId, kind, requestId, resultRef],
  );
  if (r.length !== 1 || !z.uuid().safeParse(r[0].id).success) fail('STORAGE_CONTRACT');
  return r[0].id;
}
async function random(tx: CommandReceiptTransaction) {
  const rows = await query<{ id: string }>(tx, 'SELECT gen_random_uuid()::text AS id', []);
  if (rows.length !== 1 || !z.uuid().safeParse(rows[0].id).success) fail('STORAGE_CONTRACT');
  return rows[0].id;
}
async function policy(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  input: ReadInput,
  reference: Readonly<{ recordId: string; revision: number }>,
  canUse: PracticeTrialAssessmentOptions['canUsePolicy'],
): Promise<PracticeReviewPolicyView> {
  try {
    const r = await lockApprovedPracticeReviewPolicy(
      tx,
      actor,
      { ...caseInput(input), expectedPolicyReference: reference },
      canUse,
    );
    if (!r) fail('RESOURCE_UNAVAILABLE');
    return r;
  } catch (e) {
    return normalize(e);
  }
}
function policyUseScope(
  actor: SkillTaxonomyActor,
  input: ReadInput,
  p: PracticeReviewPolicyView,
): PracticeReviewPolicyUseScope {
  return Object.freeze({
    actorAccountId: actor.accountId,
    assignmentId: input.assignmentId,
    submissionId: input.submissionId,
    purpose: 'ASSESSMENT_REVIEW',
    policyReference: p.policy.reference,
    policyVersionId: p.policy.id,
    definitionReference: p.policy.definitionReference,
    skillId: p.policy.skillId,
    skillDomain: p.policy.skillDomain,
  });
}
async function loadAssessment(
  tx: CommandReceiptTransaction,
  id: string,
  reviewId: string,
): Promise<SkillAssessmentSnapshot> {
  const rows = await query<{
    assessmentId: string;
    revision: number;
    participantId: string;
    skillId: string;
    skillDomain: string;
    state: string;
    assessedRank: string;
    definition: unknown;
    submissionId: string;
    policyVersionId: string;
    evaluatorAccountId: string;
    issuedAt: Date;
    reassessmentAt: Date | null;
    confidenceStatement: string;
    sampleSize: number;
    reviewVersionId: string;
  }>(
    tx,
    'SELECT v."assessmentId"::text,v."revision",v."participantId"::text,v."skillId",v."skillDomain",v."state",v."assessedRank",d."definition",v."submissionId"::text,v."policyVersionId"::text,v."evaluatorAccountId",v."issuedAt",v."reassessmentAt",v."confidenceStatement",v."sampleSize",v."reviewVersionId"::text FROM "SkillAssessmentVersion" v JOIN "PracticeTrialVersion" d ON d."id"=v."definitionVersionId" WHERE v."id"=$1::uuid',
    [id],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const r = rows[0],
    d = PracticeTrialDefinitionSchema.safeParse(r.definition);
  if (
    !d.success ||
    canonicalRequestDigest(d.data) !== canonicalRequestDigest(r.definition) ||
    r.reviewVersionId !== reviewId ||
    !(r.issuedAt instanceof Date) ||
    Number.isNaN(r.issuedAt.getTime()) ||
    (r.reassessmentAt !== null &&
      (!(r.reassessmentAt instanceof Date) || Number.isNaN(r.reassessmentAt.getTime())))
  )
    fail('STORAGE_CONTRACT');
  const p = SkillAssessmentSnapshotSchema.safeParse({
    version: 'v1',
    reference: { recordId: r.assessmentId, revision: r.revision },
    participantId: r.participantId,
    skillId: r.skillId,
    skillDomain: r.skillDomain,
    state: r.state,
    assessedRank: r.assessedRank,
    definitionReference: d.data.reference,
    rubricReference: d.data.rubric.reference,
    submissionReference: { recordId: r.submissionId, revision: 1 },
    evidenceReferences: [{ recordId: r.submissionId, revision: 1 }],
    assessmentPolicyVersion: r.policyVersionId,
    evaluatorAccountId: r.evaluatorAccountId,
    issuedAt: r.issuedAt.toISOString(),
    reassessmentAt: r.reassessmentAt?.toISOString() ?? null,
    confidenceStatement: r.confidenceStatement,
    sampleSize: r.sampleSize,
  });
  if (
    !p.success ||
    !Text.safeParse(r.confidenceStatement).success ||
    p.data.confidenceStatement !== r.confidenceStatement ||
    r.skillId !== d.data.skillId ||
    r.skillDomain !== d.data.skillDomain ||
    r.assessedRank !== d.data.targetRank ||
    r.sampleSize !== 1
  )
    fail('STORAGE_CONTRACT');
  return p.data;
}
async function privateView(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  input: ReadInput,
  id: string,
  revision: number,
  canRead: PracticeTrialAssessmentOptions['canRead'],
): Promise<PracticeTrialAssessmentView | null> {
  let auth = await permission(tx, actor, input, canRead);
  if (!auth) return null;
  await lockCase(tx, input.submissionId);
  await lockSkill(tx, auth.scope.participantId, auth.scope.skillId);
  auth = await permission(tx, actor, input, canRead);
  if (!auth) return null;
  const pointer = await reviewPointer(tx, input.submissionId),
    current = await family(tx, auth.scope.participantId, auth.scope.skillId);
  if (!pointer || pointer.revision < revision) fail('STORAGE_CONTRACT');
  const accessId = await random(tx);
  await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ReadPracticeTrialAssessment',
      idempotencyKey: accessId,
      requestId: accessId,
      request: {
        version: 'v1',
        assignmentId: input.assignmentId,
        submissionId: input.submissionId,
        revision,
      },
    },
    async () => ({
      resultRef: id,
      events: [
        {
          type: 'skill.practice_assessment_review_access_authorized.v1',
          aggregateId: input.submissionId,
          aggregateVersion: revision,
          payload: { practiceAssessmentReviewVersionId: id },
          publish: false,
        },
      ],
    }),
  );
  if (!(await permission(tx, actor, input, canRead))) return null;
  const rows = await query<{
    id: string;
    submissionId: string;
    revision: number;
    participantId: string;
    taxonomyId: string;
    taxonomyRevision: number;
    definition: unknown;
    assignmentId: string;
    policyVersionId: string;
    policyId: string;
    policyRevision: number;
    ownershipVersionId: string | null;
    ownershipRevision: number | null;
    assessmentVersionId: string | null;
    evaluatorAccountId: string;
    decision: string;
    reason: string;
    confidenceStatement: string;
    criteria: unknown;
    reassessmentAt: Date | null;
    reviewedAt: Date;
  }>(
    tx,
    'SELECT r."id"::text,r."submissionId"::text,r."revision",s."participantId"::text,d."taxonomyId",d."taxonomyRevision",d."definition",r."assignmentId"::text,r."policyVersionId"::text,p."policyId",p."revision" AS "policyRevision",r."ownershipVersionId"::text,o."revision" AS "ownershipRevision",r."assessmentVersionId"::text,r."evaluatorAccountId",r."decision",r."reason",r."confidenceStatement",r."criteria",r."reassessmentAt",r."reviewedAt" FROM "PracticeAssessmentReviewVersion" r JOIN "PracticeTrialSubmission" s ON s."id"=r."submissionId" JOIN "PracticeTrialVersion" d ON d."id"=r."definitionVersionId" JOIN "PracticeReviewPolicyVersion" p ON p."id"=r."policyVersionId" LEFT JOIN "PracticeTrialOwnershipVersion" o ON o."id"=r."ownershipVersionId" WHERE r."id"=$1::uuid AND r."submissionId"=$2::uuid AND r."revision"=$3::int',
    [id, input.submissionId, String(revision)],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const r = rows[0],
    d = PracticeTrialDefinitionSchema.safeParse(r.definition);
  if (
    !d.success ||
    canonicalRequestDigest(d.data) !== canonicalRequestDigest(r.definition) ||
    !(r.reviewedAt instanceof Date) ||
    Number.isNaN(r.reviewedAt.getTime()) ||
    (r.reassessmentAt !== null &&
      (!(r.reassessmentAt instanceof Date) || Number.isNaN(r.reassessmentAt.getTime())))
  )
    fail('STORAGE_CONTRACT');
  const assessment =
    r.assessmentVersionId === null ? null : await loadAssessment(tx, r.assessmentVersionId, r.id);
  const p = PracticeTrialAssessmentViewSchema.safeParse({
    version: 'v1',
    private: true,
    review: {
      version: 'v1',
      id: r.id,
      reference: { recordId: r.submissionId, revision: r.revision },
      submissionReference: { recordId: r.submissionId, revision: 1 },
      participantId: r.participantId,
      taxonomyReference: { recordId: r.taxonomyId, revision: r.taxonomyRevision },
      definitionReference: d.data.reference,
      rubricReference: d.data.rubric.reference,
      skillId: d.data.skillId,
      skillDomain: d.data.skillDomain,
      assignmentId: r.assignmentId,
      policyVersionId: r.policyVersionId,
      policyReference: { recordId: r.policyId, revision: r.policyRevision },
      ownershipVersionId: r.ownershipVersionId,
      ownershipReference: r.ownershipVersionId
        ? { recordId: r.submissionId, revision: r.ownershipRevision }
        : null,
      assessmentReference: assessment?.reference ?? null,
      evaluatorAccountId: r.evaluatorAccountId,
      decision: r.decision,
      reason: r.reason,
      confidenceStatement: r.confidenceStatement,
      criteria: r.criteria,
      reassessmentAt: r.reassessmentAt?.toISOString() ?? null,
      reviewedAt: r.reviewedAt.toISOString(),
      persisted: true,
      createsVerifiedAssessment: r.decision === 'VERIFY',
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    },
    assessment,
    currentReviewReference: { recordId: input.submissionId, revision: pointer.revision },
    currentAssessmentReference: current
      ? { recordId: current.id, revision: current.revision }
      : null,
    isCurrentReview: revision === pointer.revision,
    isCurrentAssessment:
      assessment !== null &&
      current !== null &&
      same(assessment.reference, { recordId: current.id, revision: current.revision }),
    accessId,
    isAuthorizationToken: false,
  });
  if (
    !p.success ||
    p.data.review.reason !== r.reason ||
    p.data.review.confidenceStatement !== r.confidenceStatement ||
    canonicalRequestDigest(p.data.review.criteria) !== canonicalRequestDigest(r.criteria) ||
    r.participantId !== auth.scope.participantId
  )
    fail('STORAGE_CONTRACT');
  if (!(await permission(tx, actor, input, canRead))) return null;
  return p.data;
}
/** Private scoped original/current observation; host delivers only after COMMIT. */
export async function readPracticeTrialAssessment(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canRead: PracticeTrialAssessmentOptions['canRead'],
): Promise<PracticeTrialAssessmentView | null> {
  const actor = actorValid(actorValue),
    p = ReadPracticeTrialAssessmentInputSchema.safeParse(inputValue);
  if (!p.success) fail('INVALID_INPUT');
  if (typeof canRead !== 'function') fail('STORAGE_CONTRACT');
  const input = p.data;
  const auth = await permission(tx, actor, input, canRead);
  if (!auth) return null;
  await lockCase(tx, input.submissionId);
  if (!(await permission(tx, actor, input, canRead))) return null;
  const pointer = await reviewPointer(tx, input.submissionId);
  if (!pointer) return null;
  const revision = input.revision ?? pointer.revision;
  const m = await query<{ id: string }>(
    tx,
    'SELECT "id"::text FROM "PracticeAssessmentReviewVersion" WHERE "submissionId"=$1::uuid AND "revision"=$2::int',
    [input.submissionId, String(revision)],
  );
  if (m.length > 1) fail('STORAGE_CONTRACT');
  if (!m.length) return null;
  if (!z.uuid().safeParse(m[0].id).success) fail('STORAGE_CONTRACT');
  return privateView(tx, actor, input, m[0].id, revision, canRead);
}
function criteriaValid(
  definition: PracticeTrialDefinition,
  criteria: z.output<typeof Criteria>,
  verify: boolean,
) {
  if (
    criteria.length !== definition.rubric.criteria.length ||
    definition.rubric.criteria.some((c) => !criteria.some((v) => v.criterionId === c.id))
  )
    fail('INVALID_INPUT');
  if (
    verify &&
    definition.rubric.criteria.some(
      (c) => c.required && criteria.find((v) => v.criterionId === c.id)?.result !== 'MET',
    )
  )
    fail('RUBRIC_NOT_MET');
}
/** Actual committed manual review/rank source, never a client-supplied proposal or approval flag. */
export async function recordPracticeTrialAssessment(
  tx: CommandReceiptTransaction,
  command: PracticeTrialAssessmentCommand,
  options: PracticeTrialAssessmentOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; view: PracticeTrialAssessmentView }> {
  const actor = actorValid(command?.actor),
    p = RecordPracticeTrialAssessmentInputSchema.safeParse(command?.input);
  if (!p.success) fail('INVALID_INPUT');
  if (
    typeof options?.allowNewWrites !== 'boolean' ||
    typeof options?.canRead !== 'function' ||
    typeof options?.canUsePolicy !== 'function' ||
    typeof options?.canReview !== 'function'
  )
    fail('STORAGE_CONTRACT');
  const input = p.data,
    readInput = {
      version: 'v1' as const,
      assignmentId: input.assignmentId,
      submissionId: input.submissionId,
    };
  let executedScope: PracticeTrialAssessmentScope | undefined;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RecordPracticeTrialAssessment',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      let auth = await permission(tx, actor, readInput, options.canRead);
      if (!auth) fail('RESOURCE_UNAVAILABLE');
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      let approved = await policy(
        tx,
        actor,
        readInput,
        input.expectedPolicyReference,
        options.canUsePolicy,
      );
      let evidence;
      try {
        evidence = await readPracticeTrialForReview(
          tx,
          actor,
          caseInput(readInput),
          options.canRead,
        );
      } catch (e) {
        return normalize(e);
      }
      if (!evidence) fail('RESOURCE_UNAVAILABLE');
      if (
        !same(input.expectedSubmissionReference, evidence.submission.reference) ||
        !same(input.expectedDefinitionReference, evidence.definition.reference) ||
        !same(input.expectedRubricReference, evidence.definition.rubric.reference)
      )
        fail('REVISION_CHANGED');
      await lockCase(tx, input.submissionId);
      auth = await permission(tx, actor, readInput, options.canRead);
      if (!auth) fail('RESOURCE_UNAVAILABLE');
      let ownership;
      try {
        ownership = await readPracticeTrialOwnership(
          tx,
          actor,
          caseInput(readInput),
          options.canRead,
        );
      } catch (e) {
        return normalize(e);
      }
      if (!(await permission(tx, actor, readInput, options.canRead))) fail('RESOURCE_UNAVAILABLE');
      if (!same(input.expectedOwnershipReference, ownership?.record.reference ?? null))
        fail('REVISION_CHANGED');
      if (ownership && !ownership.isCurrent) fail('STORAGE_CONTRACT');
      await lockSkill(tx, evidence.submission.participantId, evidence.definition.skillId);
      auth = await permission(tx, actor, readInput, options.canRead);
      if (!auth) fail('RESOURCE_UNAVAILABLE');
      approved = await policy(
        tx,
        actor,
        readInput,
        input.expectedPolicyReference,
        options.canUsePolicy,
      );
      const source = await query<{ id: string; taxonomyId: string; taxonomyRevision: number }>(
        tx,
        'SELECT d."id"::text,d."taxonomyId",d."taxonomyRevision" FROM "PracticeTrialSubmission" s JOIN "PracticeTrialStart" a ON a."id"=s."startId" JOIN "PracticeTrialVersion" d ON d."id"=a."definitionVersionId" WHERE s."id"=$1::uuid',
        [input.submissionId],
      );
      if (
        source.length !== 1 ||
        !z.uuid().safeParse(source[0].id).success ||
        !Reference.safeParse({
          recordId: source[0].taxonomyId,
          revision: source[0].taxonomyRevision,
        }).success
      )
        fail('STORAGE_CONTRACT');
      const d = source[0];
      const priorReview = await reviewPointer(tx, input.submissionId),
        prior = await family(tx, evidence.submission.participantId, evidence.definition.skillId),
        reviewRef = priorReview
          ? { recordId: input.submissionId, revision: priorReview.revision }
          : null,
        assessmentRef = prior ? { recordId: prior.id, revision: prior.revision } : null;
      if (
        prior &&
        (prior.skillDomain !== evidence.definition.skillDomain || prior.taxonomyId !== d.taxonomyId)
      )
        fail('FAMILY_CHANGED');
      if (
        !same(input.expectedReviewReference, reviewRef) ||
        !same(input.expectedAssessmentReference, assessmentRef)
      )
        fail('REVISION_CHANGED');
      if ((priorReview?.revision ?? 0) >= 2147483647 || (prior?.revision ?? 0) >= 2147483647)
        fail('REVISION_CHANGED');
      criteriaValid(evidence.definition, input.criteria, input.decision === 'VERIFY');
      const [clock] = await query<{ valid: boolean }>(
        tx,
        'SELECT ($1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp()) AS valid',
        [input.reassessmentAt],
      );
      if (clock?.valid !== true) fail('INVALID_INPUT');
      if (input.decision === 'VERIFY') {
        if (!ownership || ownership.record.ownership !== 'CONFIRMED')
          fail('EVIDENCE_NOT_CONFIRMED');
        if (evidence.definition.targetRank === 'S') fail('HIGH_RANK_EVIDENCE_REQUIRED');
        if (evidence.definition.evaluatorMethod !== 'MANUAL')
          fail('AUTOMATED_EVIDENCE_UNAVAILABLE');
        if (
          (evidence.definition.tools.aiAssistance === 'PROHIBITED' &&
            evidence.submission.aiAssistanceUsed) ||
          evidence.submission.toolsUsed.some(
            (t) => !evidence.definition.tools.permitted.includes(t),
          )
        )
          fail('TOOLS_POLICY_NOT_MET');
        const ranks = ['E', 'D', 'C', 'B', 'A', 'S'];
        if (
          prior?.state === 'VERIFIED' &&
          ranks.indexOf(prior.assessedRank) > ranks.indexOf(evidence.definition.targetRank)
        )
          fail('CURRENT_HIGHER_ASSESSMENT');
      }
      const scope: PracticeTrialAssessmentScope = Object.freeze({
        actorAccountId: actor.accountId,
        assignmentId: input.assignmentId,
        submissionReference: evidence.submission.reference,
        participantId: evidence.submission.participantId,
        taxonomyId: d.taxonomyId,
        taxonomyReference: { recordId: d.taxonomyId, revision: d.taxonomyRevision },
        definitionReference: evidence.definition.reference,
        rubricReference: evidence.definition.rubric.reference,
        skillId: evidence.definition.skillId,
        skillDomain: evidence.definition.skillDomain,
        targetRank: evidence.definition.targetRank,
        policyVersionId: approved.policy.id,
        policyReference: approved.policy.reference,
        ownershipVersionId: ownership?.record.id ?? null,
        ownershipReference: ownership?.record.reference ?? null,
        currentReviewReference: reviewRef,
        currentAssessmentReference: assessmentRef,
        decision: input.decision,
      });
      executedScope = scope;
      if (!allowed(options.canReview, scope)) fail('RESOURCE_UNAVAILABLE');
      const caseReceipt = await receipt(
          tx,
          actor.accountId,
          'ReadPracticeTrialForReview',
          evidence.accessId,
          input.submissionId,
        ),
        policyReceipt = await receipt(
          tx,
          actor.accountId,
          'ReadApprovedPracticeReviewPolicy',
          approved.accessId,
          approved.policy.id,
        ),
        ownershipReceipt = ownership
          ? await receipt(
              tx,
              actor.accountId,
              'ReadPracticeTrialOwnership',
              ownership.accessId,
              ownership.record.id,
            )
          : null;
      const reviewId = await random(tx),
        assessmentId = prior?.id ?? (await random(tx)),
        assessmentVersionId = input.decision === 'VERIFY' ? await random(tx) : null,
        revision = (priorReview?.revision ?? 0) + 1;
      const rows = await query<{ reviewedAt: Date }>(
        tx,
        'INSERT INTO "PracticeAssessmentReviewVersion"("id","submissionId","revision","assignmentId","definitionVersionId","policyVersionId","evaluatorAccountId","decision","reason","confidenceStatement","criteria","reassessmentAt","ownershipVersionId","assessmentVersionId","caseAccessReceiptId","policyAccessReceiptId","ownershipAccessReceiptId","receiptId","requestId") VALUES($1::uuid,$2::uuid,$3::int,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11::jsonb,$12::timestamptz,$13::uuid,$14::uuid,$15::uuid,$16::uuid,$17::uuid,$18::uuid,$19) RETURNING "reviewedAt"',
        [
          reviewId,
          input.submissionId,
          String(revision),
          input.assignmentId,
          d.id,
          approved.policy.id,
          actor.accountId,
          input.decision,
          input.reason,
          input.confidenceStatement,
          JSON.stringify(input.criteria),
          input.reassessmentAt,
          ownership?.record.id ?? null,
          assessmentVersionId,
          caseReceipt,
          policyReceipt,
          ownershipReceipt,
          receiptId,
          command.requestId,
        ],
      );
      if (
        rows.length !== 1 ||
        !(rows[0].reviewedAt instanceof Date) ||
        Number.isNaN(rows[0].reviewedAt.getTime())
      )
        fail('STORAGE_CONTRACT');
      const events: CommandOutcome['events'][number][] = [
        {
          type: 'skill.practice_assessment_review_recorded.v1',
          aggregateId: input.submissionId,
          aggregateVersion: revision,
          payload: { practiceAssessmentReviewVersionId: reviewId },
          publish: false,
        },
      ];
      if (assessmentVersionId) {
        const rankRevision = (prior?.revision ?? 0) + 1;
        const inserted = await query(
          tx,
          'INSERT INTO "SkillAssessmentVersion"("id","assessmentId","participantId","skillId","skillDomain","taxonomyId","revision","state","assessedRank","definitionVersionId","submissionId","ownershipVersionId","policyVersionId","evaluatorAccountId","reviewVersionId","issuedAt","reassessmentAt","confidenceStatement","sampleSize","receiptId","requestId") VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::int,$8,$9,$10::uuid,$11::uuid,$12::uuid,$13::uuid,$14,$15::uuid,$16::timestamptz,$17::timestamptz,$18,1,$19::uuid,$20) RETURNING "id"',
          [
            assessmentVersionId,
            assessmentId,
            evidence.submission.participantId,
            evidence.definition.skillId,
            evidence.definition.skillDomain,
            d.taxonomyId,
            String(rankRevision),
            'VERIFIED',
            evidence.definition.targetRank,
            d.id,
            input.submissionId,
            ownership?.record.id ?? null,
            approved.policy.id,
            actor.accountId,
            reviewId,
            rows[0].reviewedAt.toISOString(),
            input.reassessmentAt,
            input.confidenceStatement,
            receiptId,
            command.requestId,
          ],
        );
        if (inserted.length !== 1) fail('STORAGE_CONTRACT');
        const pointer = await query(
          tx,
          prior
            ? 'UPDATE "SkillAssessment" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1::uuid RETURNING "id"'
            : 'INSERT INTO "SkillAssessment"("id","revision","currentVersionId","participantId","skillId","skillDomain","taxonomyId") VALUES($1::uuid,$2::int,$3::uuid,$4::uuid,$5,$6,$7) RETURNING "id"',
          prior
            ? [assessmentId, String(rankRevision), assessmentVersionId]
            : [
                assessmentId,
                String(rankRevision),
                assessmentVersionId,
                evidence.submission.participantId,
                evidence.definition.skillId,
                evidence.definition.skillDomain,
                d.taxonomyId,
              ],
        );
        if (pointer.length !== 1) fail('STORAGE_CONTRACT');
        events.push({
          type: 'skill.assessment_issued.v1',
          aggregateId: assessmentId,
          aggregateVersion: rankRevision,
          payload: { skillAssessmentVersionId: assessmentVersionId },
          publish: false,
        });
      }
      const pointer = await query(
        tx,
        priorReview
          ? 'UPDATE "PracticeAssessmentReview" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "submissionId"=$1::uuid RETURNING "submissionId"'
          : 'INSERT INTO "PracticeAssessmentReview"("submissionId","revision","currentVersionId") VALUES($1::uuid,$2::int,$3::uuid) RETURNING "submissionId"',
        [input.submissionId, String(revision), reviewId],
      );
      if (pointer.length !== 1) fail('STORAGE_CONTRACT');
      if (
        !(await permission(tx, actor, readInput, options.canRead)) ||
        !allowed(options.canReview, scope)
      )
        fail('RESOURCE_UNAVAILABLE');
      await policy(tx, actor, readInput, input.expectedPolicyReference, options.canUsePolicy);
      return { resultRef: reviewId, events };
    },
  );
  if (!(await permission(tx, actor, readInput, options.canRead))) fail('RESOURCE_UNAVAILABLE');
  const m = await query<{ id: string; submissionId: string; revision: number }>(
    tx,
    'SELECT "id"::text,"submissionId"::text,"revision" FROM "PracticeAssessmentReviewVersion" WHERE "id"=$1::uuid',
    [result.resultRef],
  );
  if (
    m.length !== 1 ||
    m[0].submissionId !== input.submissionId ||
    !Reference.safeParse({ recordId: m[0].submissionId, revision: m[0].revision }).success
  )
    fail('STORAGE_CONTRACT');
  const view = await privateView(tx, actor, readInput, m[0].id, m[0].revision, options.canRead);
  if (!view) fail('RESOURCE_UNAVAILABLE');
  if (result.status === 'EXECUTED') {
    if (!executedScope) fail('STORAGE_CONTRACT');
    const finalPolicy = await policy(
      tx,
      actor,
      readInput,
      input.expectedPolicyReference,
      options.canUsePolicy,
    );
    if (
      !(await permission(tx, actor, readInput, options.canRead)) ||
      !allowed(options.canUsePolicy, policyUseScope(actor, readInput, finalPolicy)) ||
      !allowed(options.canReview, executedScope)
    )
      fail('RESOURCE_UNAVAILABLE');
  }
  return { status: result.status, view };
}

/** Initial current references for this actual assigned case; no guessed revision or other-case bytes. */
export async function observePracticeTrialAssessmentContext(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canRead: PracticeTrialAssessmentOptions['canRead'],
): Promise<PracticeTrialAssessmentContext | null> {
  const actor = actorValid(actorValue),
    p = ObservePracticeTrialAssessmentContextInputSchema.safeParse(inputValue);
  if (!p.success) fail('INVALID_INPUT');
  if (typeof canRead !== 'function') fail('STORAGE_CONTRACT');
  const input = p.data;
  let auth = await permission(tx, actor, input, canRead);
  if (!auth) return null;
  await lockCase(tx, input.submissionId);
  await lockSkill(tx, auth.scope.participantId, auth.scope.skillId);
  auth = await permission(tx, actor, input, canRead);
  if (!auth) return null;
  const accessId = await random(tx);
  await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ObservePracticeTrialAssessmentContext',
      idempotencyKey: accessId,
      requestId: accessId,
      request: input,
    },
    async () => ({
      resultRef: input.submissionId,
      events: [
        {
          type: 'skill.practice_assessment_context_access_authorized.v1',
          aggregateId: input.submissionId,
          aggregateVersion: 1,
          payload: { practiceTrialSubmissionId: input.submissionId },
          publish: false,
        },
      ],
    }),
  );
  if (!(await permission(tx, actor, input, canRead))) return null;
  const rows = await query<{
    taxonomyId: string;
    taxonomyRevision: number;
    definitionReference: unknown;
    rubricReference: unknown;
    skillId: string;
    skillDomain: string;
    targetRank: string;
    evaluatorMethod: string;
  }>(
    tx,
    `SELECT d."taxonomyId",d."taxonomyRevision",d."definition"->'reference' AS "definitionReference",d."definition"->'rubric'->'reference' AS "rubricReference",d."definition"->>'skillId' AS "skillId",d."definition"->>'skillDomain' AS "skillDomain",d."definition"->>'targetRank' AS "targetRank",d."definition"->>'evaluatorMethod' AS "evaluatorMethod" FROM "PracticeTrialSubmission" s JOIN "PracticeTrialStart" a ON a."id"=s."startId" JOIN "PracticeTrialVersion" d ON d."id"=a."definitionVersionId" WHERE s."id"=$1::uuid`,
    [input.submissionId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const source = rows[0];
  const owned = await query<{ revision: number }>(
    tx,
    'SELECT "revision" FROM "PracticeTrialOwnership" WHERE "submissionId"=$1::uuid',
    [input.submissionId],
  );
  if (owned.length > 1) fail('STORAGE_CONTRACT');
  const review = await reviewPointer(tx, input.submissionId);
  // A new-case reviewer needs CAS metadata, never another case's private assessment/reasons.
  const assessed = await query<{ id: string; revision: number }>(
    tx,
    'SELECT "id"::text,"revision" FROM "SkillAssessment" WHERE "participantId"=$1::uuid AND "skillId"=$2',
    [auth.scope.participantId, auth.scope.skillId],
  );
  if (assessed.length > 1 || (assessed.length === 1 && !z.uuid().safeParse(assessed[0].id).success))
    fail('STORAGE_CONTRACT');
  const value = PracticeTrialAssessmentContextSchema.safeParse({
    version: 'v1',
    private: true,
    assignmentId: input.assignmentId,
    participantId: auth.scope.participantId,
    submissionReference: { recordId: input.submissionId, revision: 1 },
    definitionReference: source.definitionReference,
    rubricReference: source.rubricReference,
    taxonomyReference: { recordId: source.taxonomyId, revision: source.taxonomyRevision },
    skillId: source.skillId,
    skillDomain: source.skillDomain,
    targetRank: source.targetRank,
    evaluatorMethod: source.evaluatorMethod,
    currentOwnershipReference: owned.length
      ? { recordId: input.submissionId, revision: owned[0].revision }
      : null,
    currentReviewReference: review
      ? { recordId: input.submissionId, revision: review.revision }
      : null,
    currentAssessmentReference: assessed.length
      ? { recordId: assessed[0].id, revision: assessed[0].revision }
      : null,
    accessId,
    verifiesSkill: false,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  });
  if (
    !value.success ||
    value.data.skillId !== auth.scope.skillId ||
    value.data.skillDomain !== auth.scope.skillDomain
  )
    fail('STORAGE_CONTRACT');
  if (!(await permission(tx, actor, input, canRead))) return null;
  return value.data;
}

export interface PracticeAssessmentDecisionScope {
  readonly actorAccountId: string;
  readonly assignmentId: string;
  readonly participantId: string;
  readonly taxonomyId: string;
  readonly skillId: string;
  readonly skillDomain: string;
  readonly submissionReference: Readonly<{ recordId: string; revision: number }>;
  readonly priorAssessmentReference: Readonly<{ recordId: string; revision: number }>;
  readonly policyVersionId: string;
  readonly policyReference: Readonly<{ recordId: string; revision: number }>;
  readonly action: 'REQUIRE_REASSESSMENT' | 'REVOKE';
  readonly reasonCategory: 'CAPABILITY_RECHECK' | 'FRAUDULENT_ASSESSMENT_EVIDENCE';
}
export interface PracticeAssessmentDecisionOptions {
  readonly allowNewWrites: boolean;
  readonly canRead: PracticeTrialAssessmentOptions['canRead'];
  readonly canUsePolicy: PracticeTrialAssessmentOptions['canUsePolicy'];
  readonly canDecide: (scope: PracticeAssessmentDecisionScope) => boolean;
}
/** Actual committed state for this assigned original case. Audit precedes private snapshot columns. */
export async function readPracticeTrialAssessmentState(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canRead: PracticeTrialAssessmentOptions['canRead'],
): Promise<PracticeTrialAssessmentState | null> {
  const actor = actorValid(actorValue),
    p = ReadPracticeTrialAssessmentInputSchema.safeParse(inputValue);
  if (!p.success) fail('INVALID_INPUT');
  if (typeof canRead !== 'function') fail('STORAGE_CONTRACT');
  const input = p.data;
  let auth = await permission(tx, actor, input, canRead);
  if (!auth) return null;
  await lockCase(tx, input.submissionId);
  await lockSkill(tx, auth.scope.participantId, auth.scope.skillId);
  auth = await permission(tx, actor, input, canRead);
  if (!auth) return null;
  const current = await family(tx, auth.scope.participantId, auth.scope.skillId);
  if (!current) return null;
  const revision = input.revision ?? current.revision;
  const m = await query<{
    id: string;
    submissionId: string;
    reviewVersionId: string;
    reviewRevision: number;
  }>(
    tx,
    'SELECT v."id"::text,v."submissionId"::text,v."reviewVersionId"::text,r."revision" AS "reviewRevision" FROM "SkillAssessmentVersion" v JOIN "PracticeAssessmentReviewVersion" r ON r."id"=v."reviewVersionId" WHERE v."assessmentId"=$1::uuid AND v."revision"=$2::int',
    [current.id, String(revision)],
  );
  if (!m.length) return null;
  if (
    m.length !== 1 ||
    !z.uuid().safeParse(m[0].id).success ||
    !z.uuid().safeParse(m[0].reviewVersionId).success
  )
    fail('STORAGE_CONTRACT');
  if (m[0].submissionId !== input.submissionId) return null;
  if (!(await permission(tx, actor, input, canRead))) return null;
  const accessId = await random(tx);
  await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ReadPracticeTrialAssessmentState',
      idempotencyKey: accessId,
      requestId: accessId,
      request: {
        version: 'v1',
        assignmentId: input.assignmentId,
        submissionId: input.submissionId,
        revision,
      },
    },
    async () => ({
      resultRef: m[0].id,
      events: [
        {
          type: 'skill.assessment_state_access_authorized.v1',
          aggregateId: current.id,
          aggregateVersion: revision,
          payload: { skillAssessmentVersionId: m[0].id },
          publish: false,
        },
      ],
    }),
  );
  if (!(await permission(tx, actor, input, canRead))) return null;
  const assessment = await loadAssessment(tx, m[0].id, m[0].reviewVersionId);
  const view = PracticeTrialAssessmentStateSchema.safeParse({
    version: 'v1',
    private: true,
    assessment,
    assessmentVersionId: m[0].id,
    taxonomyId: current.taxonomyId,
    sourceReviewReference: { recordId: input.submissionId, revision: m[0].reviewRevision },
    currentAssessmentReference: { recordId: current.id, revision: current.revision },
    isCurrent: revision === current.revision,
    accessId,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  });
  if (!view.success) fail('STORAGE_CONTRACT');
  if (!(await permission(tx, actor, input, canRead))) return null;
  return view.data;
}
type DecisionRow = {
  id: string;
  assessmentId: string;
  priorAssessmentVersionId: string;
  resultAssessmentVersionId: string;
  caseReviewVersionId: string;
  reviewRevision: number;
  ownershipVersionId: string;
  ownershipRevision: number;
  assignmentId: string;
  policyVersionId: string;
  policyId: string;
  policyRevision: number;
  evaluatorAccountId: string;
  action: string;
  reasonCategory: string;
  reason: string;
  findings: unknown;
  dueAt: Date | null;
  decidedAt: Date;
  resultRevision: number;
  priorRevision: number;
  reviewVersionId: string;
  submissionId: string;
};
async function decisionView(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  input: ReadInput,
  id: string,
  canRead: PracticeTrialAssessmentOptions['canRead'],
): Promise<PracticeAssessmentDecisionView | null> {
  let auth = await permission(tx, actor, input, canRead);
  if (!auth) return null;
  await lockCase(tx, input.submissionId);
  await lockSkill(tx, auth.scope.participantId, auth.scope.skillId);
  auth = await permission(tx, actor, input, canRead);
  if (!auth) return null;
  const current = await family(tx, auth.scope.participantId, auth.scope.skillId);
  if (!current) return null;
  const meta = await query<{ submissionId: string; revision: number }>(
    tx,
    'SELECT v."submissionId"::text,v."revision" FROM "PracticeAssessmentDecision" d JOIN "SkillAssessmentVersion" v ON v."id"=d."resultAssessmentVersionId" WHERE d."id"=$1::uuid AND v."assessmentId"=$2::uuid',
    [id, current.id],
  );
  if (!meta.length) return null;
  if (meta.length !== 1) fail('STORAGE_CONTRACT');
  if (meta[0].submissionId !== input.submissionId) return null;
  const accessId = await random(tx);
  await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ReadPracticeAssessmentDecision',
      idempotencyKey: accessId,
      requestId: accessId,
      request: {
        version: 'v1',
        assignmentId: input.assignmentId,
        submissionId: input.submissionId,
        decisionId: id,
      },
    },
    async () => ({
      resultRef: id,
      events: [
        {
          type: 'skill.assessment_decision_access_authorized.v1',
          aggregateId: current.id,
          aggregateVersion: meta[0].revision,
          payload: { practiceAssessmentDecisionId: id },
          publish: false,
        },
      ],
    }),
  );
  if (!(await permission(tx, actor, input, canRead))) return null;
  const rows = await query<DecisionRow>(
    tx,
    'SELECT d.*,r."revision" AS "reviewRevision",o."revision" AS "ownershipRevision",p."policyId",p."revision" AS "policyRevision",v."revision" AS "resultRevision",s."revision" AS "priorRevision",v."reviewVersionId",v."submissionId" FROM "PracticeAssessmentDecision" d JOIN "PracticeAssessmentReviewVersion" r ON r."id"=d."caseReviewVersionId" JOIN "PracticeTrialOwnershipVersion" o ON o."id"=d."ownershipVersionId" JOIN "PracticeReviewPolicyVersion" p ON p."id"=d."policyVersionId" JOIN "SkillAssessmentVersion" v ON v."id"=d."resultAssessmentVersionId" JOIN "SkillAssessmentVersion" s ON s."id"=d."priorAssessmentVersionId" WHERE d."id"=$1::uuid',
    [id],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const d = rows[0];
  if (
    !(d.decidedAt instanceof Date) ||
    Number.isNaN(d.decidedAt.getTime()) ||
    (d.dueAt !== null && (!(d.dueAt instanceof Date) || Number.isNaN(d.dueAt.getTime())))
  )
    fail('STORAGE_CONTRACT');
  const priorAssessment = await loadAssessment(tx, d.priorAssessmentVersionId, d.reviewVersionId),
    assessment = await loadAssessment(tx, d.resultAssessmentVersionId, d.reviewVersionId);
  const record = {
    version: 'v1',
    id: d.id,
    assessmentReference: assessment.reference,
    priorAssessmentReference: priorAssessment.reference,
    submissionReference: { recordId: input.submissionId, revision: 1 },
    caseReviewReference: { recordId: input.submissionId, revision: d.reviewRevision },
    ownershipReference: { recordId: input.submissionId, revision: d.ownershipRevision },
    assignmentId: d.assignmentId,
    policyVersionId: d.policyVersionId,
    policyReference: { recordId: d.policyId, revision: d.policyRevision },
    evaluatorAccountId: d.evaluatorAccountId,
    action: d.action,
    reasonCategory: d.reasonCategory,
    reason: d.reason,
    findings: d.findings,
    dueAt: d.dueAt?.toISOString() ?? null,
    decidedAt: d.decidedAt.toISOString(),
    persisted: true,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  };
  const view = PracticeAssessmentDecisionViewSchema.safeParse({
    version: 'v1',
    private: true,
    decision: record,
    priorAssessment,
    assessment,
    currentAssessmentReference: { recordId: current.id, revision: current.revision },
    isCurrent: current.revision === d.resultRevision,
    accessId,
    isAuthorizationToken: false,
  });
  if (!view.success || d.submissionId !== input.submissionId) fail('STORAGE_CONTRACT');
  if (!(await permission(tx, actor, input, canRead))) return null;
  return view.data;
}
export async function readPracticeAssessmentDecision(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canRead: PracticeTrialAssessmentOptions['canRead'],
): Promise<PracticeAssessmentDecisionView | null> {
  const actor = actorValid(actorValue),
    p = ReadPracticeTrialAssessmentInputSchema.safeParse(inputValue);
  if (!p.success) fail('INVALID_INPUT');
  if (typeof canRead !== 'function') fail('STORAGE_CONTRACT');
  const state = await readPracticeTrialAssessmentState(tx, actor, p.data, canRead);
  if (!state) return null;
  const rows = await query<{ decisionId: string | null }>(
    tx,
    'SELECT "decisionId"::text FROM "SkillAssessmentVersion" WHERE "id"=$1::uuid',
    [state.assessmentVersionId],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  return rows[0].decisionId ? decisionView(tx, actor, p.data, rows[0].decisionId, canRead) : null;
}
/** Actual reasoned case and atomic committed state transition. Unknown-success retries preserve original history. */
export async function recordPracticeAssessmentDecision(
  tx: CommandReceiptTransaction,
  command: PracticeTrialAssessmentCommand,
  options: PracticeAssessmentDecisionOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; view: PracticeAssessmentDecisionView }> {
  const actor = actorValid(command?.actor),
    p = RecordPracticeAssessmentDecisionInputSchema.safeParse(command?.input);
  if (!p.success) fail('INVALID_INPUT');
  if (
    typeof options?.allowNewWrites !== 'boolean' ||
    typeof options?.canRead !== 'function' ||
    typeof options?.canUsePolicy !== 'function' ||
    typeof options?.canDecide !== 'function'
  )
    fail('STORAGE_CONTRACT');
  const input = p.data,
    readInput = {
      version: 'v1' as const,
      assignmentId: input.assignmentId,
      submissionId: input.submissionId,
    };
  let executedScope: PracticeAssessmentDecisionScope | undefined;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RecordPracticeAssessmentDecision',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      if (!(await permission(tx, actor, readInput, options.canRead))) fail('RESOURCE_UNAVAILABLE');
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      let approved = await policy(
        tx,
        actor,
        readInput,
        input.expectedPolicyReference,
        options.canUsePolicy,
      );
      let evidence;
      try {
        evidence = await readPracticeTrialForReview(
          tx,
          actor,
          caseInput(readInput),
          options.canRead,
        );
      } catch (e) {
        return normalize(e);
      }
      if (!evidence) fail('RESOURCE_UNAVAILABLE');
      await lockCase(tx, input.submissionId);
      if (!(await permission(tx, actor, readInput, options.canRead))) fail('RESOURCE_UNAVAILABLE');
      let ownership;
      try {
        ownership = await readPracticeTrialOwnership(
          tx,
          actor,
          caseInput(readInput),
          options.canRead,
        );
      } catch (e) {
        return normalize(e);
      }
      if (!ownership) fail('RESOURCE_UNAVAILABLE');
      if (!same(input.expectedOwnershipReference, ownership.record.reference))
        fail('REVISION_CHANGED');
      const context = await observePracticeTrialAssessmentContext(
        tx,
        actor,
        readInput,
        options.canRead,
      );
      if (!context) fail('RESOURCE_UNAVAILABLE');
      if (
        !same(context.currentReviewReference, input.expectedReviewReference) ||
        !same(context.currentAssessmentReference, input.expectedAssessmentReference)
      )
        fail('REVISION_CHANGED');
      const review = await readPracticeTrialAssessment(tx, actor, readInput, options.canRead),
        prior = await readPracticeTrialAssessmentState(tx, actor, readInput, options.canRead);
      if (!review || !prior || !prior.isCurrent) fail('RESOURCE_UNAVAILABLE');
      if (!same(prior.assessment.reference, input.expectedAssessmentReference))
        fail('REVISION_CHANGED');
      if (
        prior.assessment.state === 'REVOKED' ||
        (input.action === 'REQUIRE_REASSESSMENT' && prior.assessment.state !== 'VERIFIED')
      )
        fail('INVALID_INPUT');
      if (prior.assessment.reference.revision >= 2147483647) fail('REVISION_CHANGED');
      const [clock] = await query<{ valid: boolean }>(
        tx,
        'SELECT ($1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp()) AS valid',
        [input.dueAt],
      );
      if (clock?.valid !== true) fail('INVALID_INPUT');
      approved = await policy(
        tx,
        actor,
        readInput,
        input.expectedPolicyReference,
        options.canUsePolicy,
      );
      if (!(await permission(tx, actor, readInput, options.canRead))) fail('RESOURCE_UNAVAILABLE');
      const scope: PracticeAssessmentDecisionScope = Object.freeze({
        actorAccountId: actor.accountId,
        assignmentId: input.assignmentId,
        participantId: prior.assessment.participantId,
        taxonomyId: prior.taxonomyId,
        skillId: prior.assessment.skillId,
        skillDomain: prior.assessment.skillDomain,
        submissionReference: prior.assessment.submissionReference,
        priorAssessmentReference: prior.assessment.reference,
        policyVersionId: approved.policy.id,
        policyReference: approved.policy.reference,
        action: input.action,
        reasonCategory: input.reasonCategory,
      });
      executedScope = scope;
      if (!allowed(options.canDecide, scope)) fail('RESOURCE_UNAVAILABLE');
      const caseReceipt = await receipt(
          tx,
          actor.accountId,
          'ReadPracticeTrialForReview',
          evidence.accessId,
          input.submissionId,
        ),
        policyReceipt = await receipt(
          tx,
          actor.accountId,
          'ReadApprovedPracticeReviewPolicy',
          approved.accessId,
          approved.policy.id,
        ),
        reviewReceipt = await receipt(
          tx,
          actor.accountId,
          'ReadPracticeTrialAssessment',
          review.accessId,
          review.review.id,
        ),
        ownershipReceipt = await receipt(
          tx,
          actor.accountId,
          'ReadPracticeTrialOwnership',
          ownership.accessId,
          ownership.record.id,
        ),
        priorReceipt = await receipt(
          tx,
          actor.accountId,
          'ReadPracticeTrialAssessmentState',
          prior.accessId,
          prior.assessmentVersionId,
        );
      const id = await random(tx),
        versionId = await random(tx),
        revision = prior.assessment.reference.revision + 1;
      await query(
        tx,
        'INSERT INTO "PracticeAssessmentDecision"("id","assessmentId","priorAssessmentVersionId","resultAssessmentVersionId","caseReviewVersionId","ownershipVersionId","assignmentId","policyVersionId","evaluatorAccountId","action","reasonCategory","reason","findings","dueAt","caseAccessReceiptId","policyAccessReceiptId","reviewAccessReceiptId","ownershipAccessReceiptId","priorAccessReceiptId","receiptId","requestId") VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11,$12,$13::jsonb,$14::timestamptz,$15::uuid,$16::uuid,$17::uuid,$18::uuid,$19::uuid,$20::uuid,$21) RETURNING "id"',
        [
          id,
          prior.assessment.reference.recordId,
          prior.assessmentVersionId,
          versionId,
          review.review.id,
          ownership.record.id,
          input.assignmentId,
          approved.policy.id,
          actor.accountId,
          input.action,
          input.reasonCategory,
          input.reason,
          JSON.stringify(input.findings),
          input.dueAt,
          caseReceipt,
          policyReceipt,
          reviewReceipt,
          ownershipReceipt,
          priorReceipt,
          receiptId,
          command.requestId,
        ],
      );
      const versions = await query(
        tx,
        'INSERT INTO "SkillAssessmentVersion"("id","assessmentId","participantId","skillId","skillDomain","taxonomyId","revision","state","assessedRank","definitionVersionId","submissionId","ownershipVersionId","policyVersionId","evaluatorAccountId","reviewVersionId","issuedAt","reassessmentAt","confidenceStatement","sampleSize","receiptId","requestId","decisionId") SELECT $1::uuid,p."assessmentId",p."participantId",p."skillId",p."skillDomain",p."taxonomyId",p."revision"+1,CASE WHEN d."action"=\'REVOKE\' THEN \'REVOKED\' ELSE \'REASSESSMENT_REQUIRED\' END,p."assessedRank",p."definitionVersionId",p."submissionId",p."ownershipVersionId",d."policyVersionId",d."evaluatorAccountId",p."reviewVersionId",d."decidedAt",d."dueAt",p."confidenceStatement",p."sampleSize",d."receiptId",d."requestId",d."id" FROM "PracticeAssessmentDecision" d JOIN "SkillAssessmentVersion" p ON p."id"=d."priorAssessmentVersionId" WHERE d."id"=$2::uuid RETURNING "id"',
        [versionId, id],
      );
      if (versions.length !== 1) fail('STORAGE_CONTRACT');
      const pointer = await query(
        tx,
        'UPDATE "SkillAssessment" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "id"=$1::uuid AND "revision"=$4::int RETURNING "id"',
        [
          prior.assessment.reference.recordId,
          String(revision),
          versionId,
          String(prior.assessment.reference.revision),
        ],
      );
      if (pointer.length !== 1) fail('REVISION_CHANGED');
      await policy(tx, actor, readInput, input.expectedPolicyReference, options.canUsePolicy);
      if (
        !(await permission(tx, actor, readInput, options.canRead)) ||
        !allowed(options.canDecide, scope)
      )
        fail('RESOURCE_UNAVAILABLE');
      return {
        resultRef: id,
        events: [
          {
            type: 'skill.assessment_decision_recorded.v1',
            aggregateId: prior.assessment.reference.recordId,
            aggregateVersion: revision,
            payload: { practiceAssessmentDecisionId: id },
            publish: false,
          },
          {
            type:
              input.action === 'REVOKE'
                ? 'skill.assessment_revoked.v1'
                : 'skill.assessment_reassessment_required.v1',
            aggregateId: prior.assessment.reference.recordId,
            aggregateVersion: revision,
            payload: { practiceAssessmentDecisionId: id },
            publish: false,
          },
        ],
      };
    },
  );
  const view = await decisionView(tx, actor, readInput, result.resultRef, options.canRead);
  if (!view) fail('RESOURCE_UNAVAILABLE');
  if (result.status === 'EXECUTED') {
    if (!executedScope) fail('STORAGE_CONTRACT');
    const approved = await policy(
      tx,
      actor,
      readInput,
      input.expectedPolicyReference,
      options.canUsePolicy,
    );
    if (
      !(await permission(tx, actor, readInput, options.canRead)) ||
      !allowed(options.canUsePolicy, policyUseScope(actor, readInput, approved)) ||
      !allowed(options.canDecide, executedScope)
    )
      fail('RESOURCE_UNAVAILABLE');
  }
  return { status: result.status, view };
}
