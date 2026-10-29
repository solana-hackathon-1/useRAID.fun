import { z } from 'zod';
import { ASSESSMENT_LOCK_SQL, assessmentLockKey } from './assessment-lock';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage-contracts';
import { lockSkillStorageActor, readPublishedSkillTaxonomy } from './taxonomy-storage';
import { lockPracticeTrialParticipant } from './practice-trial-attempt-storage';
import { SkillEvidenceFactSchema } from './eligibility-contracts';
import {
  executeIdempotentCommand,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import {
  OwnSkillAssessmentInputSchema,
  OwnSkillAssessmentViewSchema,
  OwnSkillAssessmentError,
  type OwnSkillAssessmentScope,
} from './own-assessment-contracts';
export * from './own-assessment-contracts';
function fail(code: OwnSkillAssessmentError['code']): never {
  throw new OwnSkillAssessmentError(code);
}
function normalize(e: unknown): never {
  if (e instanceof OwnSkillAssessmentError || e instanceof CommandReceiptError) throw e;
  const c = (e as { code?: string })?.code;
  if (
    c &&
    [
      'INVALID_INPUT',
      'AUTHENTICATION_REQUIRED',
      'ACCOUNT_RESTRICTED',
      'RESOURCE_UNAVAILABLE',
      'STORAGE_CONTRACT',
      'STORAGE_UNAVAILABLE',
    ].includes(c)
  )
    fail(c as OwnSkillAssessmentError['code']);
  fail('STORAGE_UNAVAILABLE');
}
async function query<R>(
  tx: CommandReceiptTransaction,
  sql: string,
  b: readonly SqlBinding[],
): Promise<R[]> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  try {
    const r = await tx.query<R>(sql, b);
    if (!Array.isArray(r)) fail('STORAGE_CONTRACT');
    return r;
  } catch (e) {
    return normalize(e);
  }
}
function allowed(fn: (s: OwnSkillAssessmentScope) => boolean, s: OwnSkillAssessmentScope) {
  try {
    return fn(Object.freeze(s)) === true;
  } catch {
    fail('STORAGE_UNAVAILABLE');
  }
}
async function authority(tx: CommandReceiptTransaction, actor: SkillTaxonomyActor) {
  try {
    return await lockPracticeTrialParticipant(tx, actor);
  } catch (e) {
    return normalize(e);
  }
}
/** Actual own committed facts at one database instant. Host delivers only after COMMIT. */
export async function readOwnSkillAssessment(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canRead: (scope: OwnSkillAssessmentScope) => boolean,
) {
  const a = SkillTaxonomyActorSchema.safeParse(actorValue),
    p = OwnSkillAssessmentInputSchema.safeParse(inputValue);
  if (!a.success || !p.success) fail('INVALID_INPUT');
  if (typeof canRead !== 'function') fail('STORAGE_CONTRACT');
  const actor = a.data,
    input = p.data,
    participant = await authority(tx, actor),
    scope = Object.freeze({
      accountId: actor.accountId,
      participantId: participant.id,
      taxonomyId: input.taxonomyId,
      skillId: input.skillId,
    });
  if (!allowed(canRead, scope)) fail('RESOURCE_UNAVAILABLE');
  let taxonomy;
  try {
    taxonomy = await readPublishedSkillTaxonomy(tx, actor, input.taxonomyId);
  } catch (e) {
    return normalize(e);
  }
  if (!taxonomy) fail('RESOURCE_UNAVAILABLE');
  const skill = taxonomy.skills.find((s) => s.id === input.skillId);
  if (!skill) fail('RESOURCE_UNAVAILABLE');
  await query(tx, ASSESSMENT_LOCK_SQL, [assessmentLockKey(participant.id, input.skillId)]);
  await authority(tx, actor);
  if (!allowed(canRead, scope)) fail('RESOURCE_UNAVAILABLE');
  const meta = await query<{
    id: string;
    revision: number;
    currentVersionId: string;
    skillDomain: string;
    taxonomyId: string;
  }>(
    tx,
    'SELECT "id"::text,"revision","currentVersionId"::text,"skillDomain","taxonomyId" FROM "SkillAssessment" WHERE "participantId"=$1::uuid AND "skillId"=$2',
    [participant.id, input.skillId],
  );
  if (meta.length > 1) fail('STORAGE_CONTRACT');
  const current = meta[0];
  if (
    current &&
    (!z.uuid().safeParse(current.id).success ||
      !z.uuid().safeParse(current.currentVersionId).success ||
      !Number.isInteger(current.revision) ||
      current.revision < 1 ||
      current.skillDomain !== skill.domain ||
      current.taxonomyId !== input.taxonomyId)
  )
    fail('RESOURCE_UNAVAILABLE');
  const [random] = await query<{ id: string }>(tx, 'SELECT gen_random_uuid()::text AS id', []);
  if (!z.uuid().safeParse(random?.id).success) fail('STORAGE_CONTRACT');
  const accessId = random.id;
  const auditPayload: Readonly<Record<string, string>> = current
    ? { skillAssessmentVersionId: current.currentVersionId }
    : {};
  await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'ReadOwnSkillAssessment',
      idempotencyKey: accessId,
      requestId: accessId,
      request: { version: 'v1', taxonomyId: input.taxonomyId, skillId: input.skillId },
    },
    async () => ({
      resultRef: current?.currentVersionId ?? participant.id,
      events: [
        {
          type: 'skill.own_assessment_access_authorized.v1',
          aggregateId: current?.id ?? participant.id,
          aggregateVersion: current?.revision ?? 1,
          payload: auditPayload,
          publish: false,
        },
      ],
    }),
  );
  await authority(tx, actor);
  if (!allowed(canRead, scope)) fail('RESOURCE_UNAVAILABLE');
  type Row = {
    state: string;
    assessedRank: string;
    assessmentId: string;
    revision: number;
    policyVersionId: string;
    evaluatorAccountId: string;
    issuedAt: Date;
    reassessmentAt: Date | null;
    definition: unknown;
    reasonCategory: string | null;
    decisionId: string | null;
    foundDecisionId: string | null;
    observedAt: Date;
  };
  const rows = current
    ? await query<Row>(
        tx,
        'SELECT v."state",v."assessedRank",v."assessmentId"::text,v."revision",v."policyVersionId"::text,v."evaluatorAccountId",v."issuedAt",v."reassessmentAt",r."definition" AS "definition",v."decisionId"::text,d."id"::text AS "foundDecisionId",d."reasonCategory",date_trunc(\'milliseconds\',clock_timestamp()) AS "observedAt" FROM "SkillAssessmentVersion" v JOIN "PracticeTrialVersion" r ON r."id"=v."definitionVersionId" LEFT JOIN "PracticeAssessmentDecision" d ON d."id"=v."decisionId" AND d."resultAssessmentVersionId"=v."id" WHERE v."id"=$1::uuid AND v."assessmentId"=$2::uuid AND v."revision"=$3::int',
        [current.currentVersionId, current.id, String(current.revision)],
      )
    : [];
  const [clock] = current
    ? rows
    : await query<{ observedAt: Date }>(
        tx,
        'SELECT date_trunc(\'milliseconds\',clock_timestamp()) AS "observedAt"',
        [],
      );
  if (
    !(clock?.observedAt instanceof Date) ||
    Number.isNaN(clock.observedAt.getTime()) ||
    (current && rows.length !== 1)
  )
    fail('STORAGE_CONTRACT');
  const observedAt = clock.observedAt.toISOString(),
    r = rows[0];
  let evidence: Extract<z.output<typeof SkillEvidenceFactSchema>, { kind: 'ASSESSMENT' }> | null =
    null;
  if (r) {
    const definition = r.definition as { rubric?: { reference?: unknown } };
    if (
      !(r.issuedAt instanceof Date) ||
      Number.isNaN(r.issuedAt.getTime()) ||
      (r.reassessmentAt !== null &&
        (!(r.reassessmentAt instanceof Date) || Number.isNaN(r.reassessmentAt.getTime()))) ||
      r.decisionId !== r.foundDecisionId
    )
      fail('STORAGE_CONTRACT');
    const fact = SkillEvidenceFactSchema.safeParse({
      kind: 'ASSESSMENT',
      skillId: input.skillId,
      domain: skill.domain,
      state: r.state,
      assessedRank: r.assessedRank,
      assessmentReference: { recordId: r.assessmentId, revision: r.revision },
      rubricReference: definition?.rubric?.reference,
      assessmentPolicyVersion: r.policyVersionId,
      evaluatorAccountId: r.evaluatorAccountId,
      issuedAt: r.issuedAt.toISOString(),
      reassessmentAt: r.reassessmentAt?.toISOString() ?? null,
    });
    if (!fact.success || fact.data.kind !== 'ASSESSMENT') fail('STORAGE_CONTRACT');
    evidence = fact.data;
  }
  const parsed = OwnSkillAssessmentViewSchema.safeParse({
    version: 'v1',
    private: true,
    skillId: input.skillId,
    skillDomain: skill.domain,
    skillName: skill.name,
    taxonomyReference: { recordId: taxonomy.id, revision: taxonomy.revision },
    assessmentReference: current ? { recordId: current.id, revision: current.revision } : null,
    recordedState: r?.state ?? null,
    effectiveStatus: r
      ? r.state === 'VERIFIED' &&
        r.reassessmentAt !== null &&
        r.reassessmentAt.getTime() <= Date.parse(observedAt)
        ? 'REASSESSMENT_REQUIRED'
        : r.state
      : 'NO_ASSESSMENT',
    assessedRank: r?.assessedRank ?? null,
    issuedAt: r?.issuedAt.toISOString() ?? null,
    reassessmentAt: r?.reassessmentAt?.toISOString() ?? null,
    reasonCategory: r?.reasonCategory ?? null,
    observedAt,
    informational: true,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  await authority(tx, actor);
  try {
    await lockSkillStorageActor(tx, actor);
  } catch (e) {
    return normalize(e);
  }
  if (!allowed(canRead, scope)) fail('RESOURCE_UNAVAILABLE');
  return Object.freeze({
    view: parsed.data,
    participant,
    taxonomy,
    evidence,
    observedAt,
    accessId,
    isAuthorizationToken: false as const,
  });
}
