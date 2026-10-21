import { z } from 'zod';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage';
import { PracticeTrialDefinitionSchema } from './practice-trial-contracts';
import {
  lockPracticeReviewAssignment,
  type PracticeReviewAssignmentUseScope,
} from './practice-review-assignment-storage';
import { readPracticeTrialForReview } from './practice-review-read-storage';
import {
  lockApprovedPracticeReviewPolicy,
  type PracticeReviewPolicyUseScope,
} from './practice-review-policy-storage';
import {
  executeIdempotentCommand,
  canonicalRequestDigest,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
export * from './practice-trial-ownership-contracts';
import {
  RecordPracticeTrialOwnershipInputSchema,
  ReadPracticeTrialOwnershipInputSchema,
  PracticeTrialOwnershipViewSchema,
  PracticeOwnershipDecisionSchema as Decision,
  type PracticeTrialOwnershipView,
} from './practice-trial-ownership-contracts';
export interface PracticeTrialOwnershipCommand {
  readonly actor: SkillTaxonomyActor;
  readonly input: unknown;
  readonly idempotencyKey: string;
  readonly requestId: string;
}
export interface PracticeTrialOwnershipScope {
  readonly actorAccountId: string;
  readonly assignmentId: string;
  readonly submissionReference: Readonly<{ recordId: string; revision: number }>;
  readonly participantId: string;
  readonly definitionReference: Readonly<{ recordId: string; revision: number }>;
  readonly rubricReference: Readonly<{ recordId: string; revision: number }>;
  readonly skillId: string;
  readonly skillDomain: string;
  readonly policyVersionId: string;
  readonly policyReference: Readonly<{ recordId: string; revision: number }>;
  readonly currentOwnershipReference: Readonly<{ recordId: string; revision: number }> | null;
  readonly decision: 'CONFIRM' | 'DISPUTE' | 'MORE_EVIDENCE';
}
export interface PracticeTrialOwnershipOptions {
  readonly allowNewWrites: boolean;
  readonly canRead: (scope: PracticeReviewAssignmentUseScope) => boolean;
  readonly canUsePolicy: (scope: PracticeReviewPolicyUseScope) => boolean;
  readonly canReview: (scope: PracticeTrialOwnershipScope) => boolean;
}
export class PracticeTrialOwnershipError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'AUTHENTICATION_REQUIRED'
      | 'ACCOUNT_RESTRICTED'
      | 'RESOURCE_UNAVAILABLE'
      | 'WRITES_DISABLED'
      | 'REVISION_CHANGED'
      | 'STORAGE_CONTRACT'
      | 'STORAGE_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'PracticeTrialOwnershipError';
  }
}
function fail(code: PracticeTrialOwnershipError['code']): never {
  throw new PracticeTrialOwnershipError(code);
}
function ownership(decision: z.output<typeof Decision>) {
  return decision === 'CONFIRM' ? 'CONFIRMED' : decision === 'DISPUTE' ? 'DISPUTED' : 'UNCONFIRMED';
}
function same(
  a: Readonly<{ recordId: string; revision: number }> | null,
  b: Readonly<{ recordId: string; revision: number }> | null,
) {
  return a === null || b === null
    ? a === b
    : a.recordId === b.recordId && a.revision === b.revision;
}
function actorValid(value: unknown) {
  const r = SkillTaxonomyActorSchema.safeParse(value);
  if (!r.success) fail('INVALID_INPUT');
  return r.data;
}
function allowed<T>(fn: (v: T) => boolean, value: T) {
  try {
    return fn(Object.freeze(value)) === true;
  } catch {
    fail('STORAGE_UNAVAILABLE');
  }
}
function normalize(error: unknown): never {
  if (error instanceof PracticeTrialOwnershipError || error instanceof CommandReceiptError)
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
    fail(code as PracticeTrialOwnershipError['code']);
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
    const rows = await tx.query<R>(sql, bindings);
    if (!Array.isArray(rows)) fail('STORAGE_CONTRACT');
    return rows;
  } catch (e) {
    if (e instanceof PracticeTrialOwnershipError || e instanceof CommandReceiptError) throw e;
    fail('STORAGE_UNAVAILABLE');
  }
}
type ReadInput = z.output<typeof ReadPracticeTrialOwnershipInputSchema>;
async function permission(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  input: ReadInput,
  canRead: PracticeTrialOwnershipOptions['canRead'],
) {
  try {
    let actualScope: PracticeReviewAssignmentUseScope | undefined;
    const grant = await lockPracticeReviewAssignment(
      tx,
      actor,
      {
        assignmentId: input.assignmentId,
        submissionId: input.submissionId,
        purpose: input.purpose,
      },
      (scope) => {
        actualScope = scope;
        return allowed(canRead, scope);
      },
    );
    return grant && actualScope && allowed(canRead, actualScope) ? grant : null;
  } catch (e) {
    return normalize(e);
  }
}
async function lockCase(tx: CommandReceiptTransaction, submissionId: string) {
  await query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,12020))::text', [submissionId]);
}
async function current(tx: CommandReceiptTransaction, submissionId: string) {
  const r = await query<{ revision: number; currentVersionId: string }>(
    tx,
    'SELECT "revision","currentVersionId"::text FROM "PracticeTrialOwnership" WHERE "submissionId"=$1::uuid',
    [submissionId],
  );
  if (r.length > 1) fail('STORAGE_CONTRACT');
  if (!r.length) return null;
  if (
    !z.number().int().min(1).max(2147483647).safeParse(r[0].revision).success ||
    !z.uuid().safeParse(r[0].currentVersionId).success
  )
    fail('STORAGE_CONTRACT');
  return r[0];
}
async function access(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  input: ReadInput,
  id: string,
  revision: number,
) {
  const r = await query<{ id: string }>(tx, 'SELECT gen_random_uuid()::text AS id', []);
  if (r.length !== 1 || !z.uuid().safeParse(r[0].id).success) fail('STORAGE_CONTRACT');
  const accessId = r[0].id;
  await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ReadPracticeTrialOwnership',
      idempotencyKey: accessId,
      requestId: accessId,
      request: {
        version: 'v1',
        assignmentId: input.assignmentId,
        submissionId: input.submissionId,
        purpose: input.purpose,
        revision,
      },
    },
    async () => ({
      resultRef: id,
      events: [
        {
          type: 'skill.practice_trial_ownership_access_authorized.v1',
          aggregateId: input.submissionId,
          aggregateVersion: revision,
          payload: { practiceTrialOwnershipVersionId: id },
          publish: false,
        },
      ],
    }),
  );
  return accessId;
}
async function view(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  input: ReadInput,
  id: string,
  revision: number,
  canRead: PracticeTrialOwnershipOptions['canRead'],
): Promise<PracticeTrialOwnershipView | null> {
  if (!(await permission(tx, actor, input, canRead))) return null;
  // This mutex is also held by all writers. It never grants permission to private fields.
  await lockCase(tx, input.submissionId);
  if (!(await permission(tx, actor, input, canRead))) return null;
  const pointer = await current(tx, input.submissionId);
  if (!pointer || pointer.revision < revision) fail('STORAGE_CONTRACT');
  const accessId = await access(tx, actor, input, id, revision);
  if (!(await permission(tx, actor, input, canRead))) return null;
  const rows = await query<{
    id: string;
    submissionId: string;
    revision: number;
    participantId: string;
    definition: unknown;
    assignmentId: string;
    policyVersionId: string;
    policyId: string;
    policyRevision: number;
    evaluatorAccountId: string;
    decision: string;
    reason: string;
    observations: unknown;
    caseAccessId: string;
    policyAccessId: string;
    reviewedAt: Date;
  }>(
    tx,
    'SELECT v."id"::text,v."submissionId"::text,v."revision",s."participantId"::text,d."definition",v."assignmentId"::text,v."policyVersionId"::text,p."policyId",p."revision" AS "policyRevision",v."evaluatorAccountId",v."decision",v."reason",v."observations",c."requestId" AS "caseAccessId",a."requestId" AS "policyAccessId",v."reviewedAt" FROM "PracticeTrialOwnershipVersion" v JOIN "PracticeTrialSubmission" s ON s."id"=v."submissionId" JOIN "PracticeTrialVersion" d ON d."id"=v."definitionVersionId" JOIN "PracticeReviewPolicyVersion" p ON p."id"=v."policyVersionId" JOIN "CommandReceipt" c ON c."id"=v."caseAccessReceiptId" JOIN "CommandReceipt" a ON a."id"=v."policyAccessReceiptId" WHERE v."id"=$1::uuid AND v."submissionId"=$2::uuid AND v."revision"=$3::int',
    [id, input.submissionId, String(revision)],
  );
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const r = rows[0],
    d = PracticeTrialDefinitionSchema.safeParse(r.definition),
    dec = Decision.safeParse(r.decision);
  if (
    !d.success ||
    canonicalRequestDigest(d.data) !== canonicalRequestDigest(r.definition) ||
    !dec.success ||
    !(r.reviewedAt instanceof Date) ||
    Number.isNaN(r.reviewedAt.getTime())
  )
    fail('STORAGE_CONTRACT');
  const parsed = PracticeTrialOwnershipViewSchema.safeParse({
    version: 'v1',
    private: true,
    record: {
      version: 'v1',
      id: r.id,
      reference: { recordId: r.submissionId, revision: r.revision },
      submissionReference: { recordId: r.submissionId, revision: 1 },
      participantId: r.participantId,
      definitionReference: d.data.reference,
      rubricReference: d.data.rubric.reference,
      skillId: d.data.skillId,
      skillDomain: d.data.skillDomain,
      assignmentId: r.assignmentId,
      policyVersionId: r.policyVersionId,
      policyReference: { recordId: r.policyId, revision: r.policyRevision },
      evaluatorAccountId: r.evaluatorAccountId,
      decision: dec.data,
      ownership: ownership(dec.data),
      reason: r.reason,
      observations: r.observations,
      caseAccessId: r.caseAccessId,
      policyAccessId: r.policyAccessId,
      reviewedAt: r.reviewedAt.toISOString(),
      persisted: true,
      verifiesSkill: false,
      isAuthorizationToken: false,
      createsPermissionGrant: false,
      consumesCapacity: false,
      createsFinancialObligation: false,
    },
    currentReference: { recordId: input.submissionId, revision: pointer.revision },
    isCurrent: revision === pointer.revision,
    accessId,
    isAuthorizationToken: false,
  });
  if (
    !parsed.success ||
    parsed.data.record.reason !== r.reason ||
    canonicalRequestDigest(parsed.data.record.observations) !==
      canonicalRequestDigest(r.observations)
  )
    fail('STORAGE_CONTRACT');
  if (!(await permission(tx, actor, input, canRead))) return null;
  return parsed.data;
}
/** Private historical/current observation. Deliver only after COMMIT; never an authorization token. */
export async function readPracticeTrialOwnership(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canRead: PracticeTrialOwnershipOptions['canRead'],
): Promise<PracticeTrialOwnershipView | null> {
  const actor = actorValid(actorValue),
    p = ReadPracticeTrialOwnershipInputSchema.safeParse(inputValue);
  if (!p.success) fail('INVALID_INPUT');
  if (typeof canRead !== 'function') fail('STORAGE_CONTRACT');
  const input = p.data;
  if (!(await permission(tx, actor, input, canRead))) return null;
  await lockCase(tx, input.submissionId);
  if (!(await permission(tx, actor, input, canRead))) return null;
  const pointer = await current(tx, input.submissionId);
  if (!pointer) return null;
  const revision = input.revision ?? pointer.revision;
  const m = await query<{ id: string }>(
    tx,
    'SELECT "id"::text FROM "PracticeTrialOwnershipVersion" WHERE "submissionId"=$1::uuid AND "revision"=$2::int',
    [input.submissionId, String(revision)],
  );
  if (m.length > 1) fail('STORAGE_CONTRACT');
  if (!m.length) return null;
  if (!z.uuid().safeParse(m[0].id).success) fail('STORAGE_CONTRACT');
  return view(tx, actor, input, m[0].id, revision, canRead);
}
async function accessReceipt(
  tx: CommandReceiptTransaction,
  actorId: string,
  kind: string,
  accessId: string,
  resultRef: string,
) {
  const r = await query<{ id: string }>(
    tx,
    'SELECT "id"::text FROM "CommandReceipt" WHERE "actorId"=$1 AND "commandKind"=$2 AND "requestId"=$3 AND "resultRef"=$4',
    [actorId, kind, accessId, resultRef],
  );
  if (r.length !== 1 || !z.uuid().safeParse(r[0].id).success) fail('STORAGE_CONTRACT');
  return r[0].id;
}
/** All source and authority locks are held in this same transaction until host COMMIT. */
export async function recordPracticeTrialOwnership(
  tx: CommandReceiptTransaction,
  command: PracticeTrialOwnershipCommand,
  options: PracticeTrialOwnershipOptions,
): Promise<{ status: 'EXECUTED' | 'REPLAYED'; view: PracticeTrialOwnershipView }> {
  const actor = actorValid(command?.actor),
    parsed = RecordPracticeTrialOwnershipInputSchema.safeParse(command?.input);
  if (!parsed.success) fail('INVALID_INPUT');
  if (
    typeof options?.allowNewWrites !== 'boolean' ||
    typeof options?.canRead !== 'function' ||
    typeof options?.canUsePolicy !== 'function' ||
    typeof options?.canReview !== 'function'
  )
    fail('STORAGE_CONTRACT');
  const input = parsed.data,
    readInput = {
      version: 'v1' as const,
      assignmentId: input.assignmentId,
      submissionId: input.submissionId,
      purpose: 'OWNERSHIP_REVIEW' as const,
    };
  let executedScope: PracticeTrialOwnershipScope | undefined;
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'RecordPracticeTrialOwnership',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async ({ receiptId }) => {
      if (!(await permission(tx, actor, readInput, options.canRead))) fail('RESOURCE_UNAVAILABLE');
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      let policy;
      try {
        policy = await lockApprovedPracticeReviewPolicy(
          tx,
          actor,
          { ...readInput, expectedPolicyReference: input.expectedPolicyReference },
          options.canUsePolicy,
        );
      } catch (e) {
        return normalize(e);
      }
      if (!policy) fail('RESOURCE_UNAVAILABLE');
      let evidence;
      try {
        evidence = await readPracticeTrialForReview(tx, actor, readInput, options.canRead);
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
      if (!(await permission(tx, actor, readInput, options.canRead))) fail('RESOURCE_UNAVAILABLE');
      // D3 policy mutex is already held; reauthorization after the ownership wait is mandatory.
      try {
        policy = await lockApprovedPracticeReviewPolicy(
          tx,
          actor,
          { ...readInput, expectedPolicyReference: input.expectedPolicyReference },
          options.canUsePolicy,
        );
      } catch (e) {
        return normalize(e);
      }
      if (!policy) fail('RESOURCE_UNAVAILABLE');
      const old = await current(tx, input.submissionId),
        currentReference = old ? { recordId: input.submissionId, revision: old.revision } : null;
      if (!same(currentReference, input.expectedOwnershipReference)) fail('REVISION_CHANGED');
      if ((old?.revision ?? 0) >= 2147483647) fail('REVISION_CHANGED');
      const scope: PracticeTrialOwnershipScope = Object.freeze({
        actorAccountId: actor.accountId,
        assignmentId: input.assignmentId,
        submissionReference: evidence.submission.reference,
        participantId: evidence.submission.participantId,
        definitionReference: evidence.definition.reference,
        rubricReference: evidence.definition.rubric.reference,
        skillId: evidence.definition.skillId,
        skillDomain: evidence.definition.skillDomain,
        policyVersionId: policy.policy.id,
        policyReference: policy.policy.reference,
        currentOwnershipReference: currentReference,
        decision: input.decision,
      });
      executedScope = scope;
      if (!allowed(options.canReview, scope)) fail('RESOURCE_UNAVAILABLE');
      const sources = await query<{ id: string }>(
        tx,
        'SELECT t."definitionVersionId"::text AS id FROM "PracticeTrialSubmission" s JOIN "PracticeTrialStart" t ON t."id"=s."startId" WHERE s."id"=$1::uuid',
        [input.submissionId],
      );
      if (sources.length !== 1 || !z.uuid().safeParse(sources[0].id).success)
        fail('STORAGE_CONTRACT');
      const caseReceipt = await accessReceipt(
          tx,
          actor.accountId,
          'ReadPracticeTrialForReview',
          evidence.accessId,
          input.submissionId,
        ),
        policyReceipt = await accessReceipt(
          tx,
          actor.accountId,
          'ReadApprovedPracticeReviewPolicy',
          policy.accessId,
          policy.policy.id,
        ),
        revision = (old?.revision ?? 0) + 1;
      const rows = await query<{ id: string }>(
        tx,
        'INSERT INTO "PracticeTrialOwnershipVersion"("submissionId","revision","assignmentId","definitionVersionId","policyVersionId","evaluatorAccountId","decision","reason","observations","caseAccessReceiptId","policyAccessReceiptId","receiptId","requestId") VALUES($1::uuid,$2::int,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::jsonb,$10::uuid,$11::uuid,$12::uuid,$13) RETURNING "id"::text',
        [
          input.submissionId,
          String(revision),
          input.assignmentId,
          sources[0].id,
          policy.policy.id,
          actor.accountId,
          input.decision,
          input.reason,
          JSON.stringify(input.observations),
          caseReceipt,
          policyReceipt,
          receiptId,
          command.requestId,
        ],
      );
      if (rows.length !== 1 || !z.uuid().safeParse(rows[0].id).success) fail('STORAGE_CONTRACT');
      const pointer = await query(
        tx,
        old
          ? 'UPDATE "PracticeTrialOwnership" SET "revision"=$2::int,"currentVersionId"=$3::uuid WHERE "submissionId"=$1::uuid RETURNING "submissionId"'
          : 'INSERT INTO "PracticeTrialOwnership"("submissionId","revision","currentVersionId") VALUES($1::uuid,$2::int,$3::uuid) RETURNING "submissionId"',
        [input.submissionId, String(revision), rows[0].id],
      );
      if (pointer.length !== 1) fail('STORAGE_CONTRACT');
      if (
        !(await permission(tx, actor, readInput, options.canRead)) ||
        !allowed(options.canReview, scope)
      )
        fail('RESOURCE_UNAVAILABLE');
      // Recheck dynamic policy use without treating an earlier returned snapshot as authority.
      try {
        if (
          !(await lockApprovedPracticeReviewPolicy(
            tx,
            actor,
            { ...readInput, expectedPolicyReference: input.expectedPolicyReference },
            options.canUsePolicy,
          ))
        )
          fail('RESOURCE_UNAVAILABLE');
      } catch (e) {
        return normalize(e);
      }
      return {
        resultRef: rows[0].id,
        events: [
          {
            type: 'skill.practice_trial_ownership_recorded.v1',
            aggregateId: input.submissionId,
            aggregateVersion: revision,
            payload: { practiceTrialOwnershipVersionId: rows[0].id },
            publish: false,
          },
        ],
      };
    },
  );
  // Original successful retries remain history, but require current case permission before fields.
  if (!(await permission(tx, actor, readInput, options.canRead))) fail('RESOURCE_UNAVAILABLE');
  const m = await query<{ id: string; submissionId: string; revision: number }>(
    tx,
    'SELECT "id"::text,"submissionId"::text,"revision" FROM "PracticeTrialOwnershipVersion" WHERE "id"=$1::uuid',
    [result.resultRef],
  );
  if (
    m.length !== 1 ||
    m[0].submissionId !== input.submissionId ||
    !z.number().int().min(1).max(2147483647).safeParse(m[0].revision).success
  )
    fail('STORAGE_CONTRACT');
  const recordView = await view(tx, actor, readInput, m[0].id, m[0].revision, options.canRead);
  if (!recordView) fail('RESOURCE_UNAVAILABLE');
  // Result/audit selection can wait too. Newly executed decisions retain current authority
  // through this last boundary; historical retries deliberately require only current reads.
  if (result.status === 'EXECUTED') {
    if (!executedScope) fail('STORAGE_CONTRACT');
    let finalPolicy;
    try {
      finalPolicy = await lockApprovedPracticeReviewPolicy(
        tx,
        actor,
        { ...readInput, expectedPolicyReference: input.expectedPolicyReference },
        options.canUsePolicy,
      );
    } catch (error) {
      return normalize(error);
    }
    if (!finalPolicy) fail('RESOURCE_UNAVAILABLE');
    if (!(await permission(tx, actor, readInput, options.canRead))) fail('RESOURCE_UNAVAILABLE');
    // These actual held-source scope predicates are synchronous, with no later await.
    // A distinct policy can close while the final case/session query waits.
    const finalPolicyScope: PracticeReviewPolicyUseScope = Object.freeze({
      actorAccountId: actor.accountId,
      assignmentId: input.assignmentId,
      submissionId: input.submissionId,
      purpose: 'OWNERSHIP_REVIEW',
      policyReference: finalPolicy.policy.reference,
      policyVersionId: finalPolicy.policy.id,
      definitionReference: finalPolicy.policy.definitionReference,
      skillId: finalPolicy.policy.skillId,
      skillDomain: finalPolicy.policy.skillDomain,
    });
    if (
      !allowed(options.canUsePolicy, finalPolicyScope) ||
      !allowed(options.canReview, executedScope)
    )
      fail('RESOURCE_UNAVAILABLE');
  }

  return { status: result.status, view: recordView };
}
