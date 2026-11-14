import { z } from 'zod';
import {
  executeIdempotentCommand,
  CommandReceiptError,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { ASSESSMENT_LOCK_SQL, assessmentLockKey } from '../skills/assessment-lock';
import { lockPracticeTrialParticipant } from '../skills/practice-trial-attempt-storage';
import { lockSkillStorageActor } from '../skills/taxonomy-storage';
import { evaluateAppealAdjudicator } from './policy';
import {
  AdjudicateSkillAssessmentAppealInputSchema,
  FileSkillAssessmentAppealInputSchema,
  SkillAppealActorSchema,
  SkillAppealError,
  SkillAssessmentAppealViewSchema,
  type AdjudicateSkillAssessmentAppealOptions,
  type FileSkillAssessmentAppealOptions,
  type OverdueSkillAssessmentAppeal,
  type SkillAppealActor,
  type SkillAppealCommand,
  type SkillAssessmentAppealResult,
  type SkillAssessmentAppealView,
} from './contracts';
export * from './contracts';
export * from './policy';

function fail(code: SkillAppealError['code']): never {
  throw new SkillAppealError(code);
}
const PASS_THROUGH = new Set([
  'AUTHENTICATION_REQUIRED',
  'ACCOUNT_RESTRICTED',
  'STORAGE_CONTRACT',
  'STORAGE_UNAVAILABLE',
  'INVALID_INPUT',
]);
/** Maps a lower-layer storage error without leaking its detail; unknown failures stay opaque. */
function normalize(error: unknown): never {
  if (error instanceof SkillAppealError || error instanceof CommandReceiptError) throw error;
  const code = (error as { code?: string } | null)?.code;
  // A missing HUMAN participant is "no such assessment" for the caller, never a hint about other accounts.
  if (code === 'RESOURCE_UNAVAILABLE') return fail('NOT_FOUND');
  if (code && PASS_THROUGH.has(code)) return fail(code as SkillAppealError['code']);
  return fail('STORAGE_UNAVAILABLE');
}
async function query<Row>(
  tx: CommandReceiptTransaction,
  sql: string,
  bindings: readonly SqlBinding[],
): Promise<Row[]> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  try {
    const rows = await tx.query<Row>(sql, bindings);
    if (!Array.isArray(rows)) fail('STORAGE_CONTRACT');
    return rows;
  } catch (error) {
    return normalize(error);
  }
}
const instant = (value: unknown) => {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) fail('STORAGE_CONTRACT');
  return date.toISOString();
};
function validCommand(command: SkillAppealCommand | undefined) {
  const actor = SkillAppealActorSchema.safeParse(command?.actor);
  if (!actor.success) fail('INVALID_INPUT');
  return actor.data as SkillAppealActor;
}
const SECONDS = z
  .number()
  .int()
  .min(1)
  .max(3650 * 86400);

interface AppealRow {
  id: string;
  assessmentId: string;
  revision: number;
  skillId: string;
  reasonCategory: string;
  filedAt: unknown;
  adjudicationDueAt: unknown;
  outcome: string | null;
  decidedAt: unknown;
  participantId: string;
}
const VIEW_SQL = `SELECT a."id"::text AS "id",v."assessmentId"::text AS "assessmentId",v."revision",v."skillId",a."reasonCategory",a."filedAt",a."adjudicationDueAt",d."outcome",d."decidedAt",a."participantId"::text AS "participantId" FROM "SkillAssessmentAppeal" a JOIN "SkillAssessmentVersion" v ON v."id"=a."assessmentVersionId" LEFT JOIN "SkillAssessmentAppealDecision" d ON d."appealId"=a."id" WHERE a."id"=$1::uuid`;
async function loadView(
  tx: CommandReceiptTransaction,
  appealId: string,
  ownerParticipantId: string | null,
): Promise<SkillAssessmentAppealView> {
  const rows = await query<AppealRow>(tx, VIEW_SQL, [appealId]);
  if (rows.length !== 1) fail('STORAGE_CONTRACT');
  const r = rows[0];
  if (ownerParticipantId !== null && r.participantId !== ownerParticipantId) fail('NOT_FOUND');
  const state = r.outcome === null ? 'PENDING' : r.outcome;
  const parsed = SkillAssessmentAppealViewSchema.safeParse({
    version: 'v1',
    id: r.id,
    assessmentReference: { recordId: r.assessmentId, revision: r.revision },
    skillId: r.skillId,
    reasonCategory: r.reasonCategory,
    state,
    filedAt: instant(r.filedAt),
    adjudicationDueAt: instant(r.adjudicationDueAt),
    decidedAt: r.decidedAt === null || r.decidedAt === undefined ? null : instant(r.decidedAt),
    freshReview: {
      required: state === 'UPHELD',
      excludesOriginalReviewers: state === 'UPHELD',
    },
    changesAssessment: false,
    grantsRank: false,
    isAuthorizationToken: false,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
async function lockAssessment(
  tx: CommandReceiptTransaction,
  participantId: string,
  skillId: string,
) {
  await query(tx, ASSESSMENT_LOCK_SQL, [assessmentLockKey(participantId, skillId)]);
}

/**
 * The participant files one appeal against the current decided version of their own assessment (blueprint 09.7,
 * DEC-2026-11-13-12 / -14-11). Receipt -> User/Session/Participant -> per-person/skill assessment lock -> projection.
 * The appeal records the filing and the adjudication target only: the appealed decision stays in effect, no rank,
 * capacity, permission or money is created or changed, and the statement stays private to the case.
 */
export async function fileSkillAssessmentAppeal(
  tx: CommandReceiptTransaction,
  command: SkillAppealCommand,
  options: FileSkillAssessmentAppealOptions,
): Promise<SkillAssessmentAppealResult> {
  const actor = validCommand(command);
  const input = FileSkillAssessmentAppealInputSchema.safeParse(command.input);
  if (!input.success) fail('INVALID_INPUT');
  if (
    typeof options?.allowNewWrites !== 'boolean' ||
    !SECONDS.safeParse(options.filingWindowSeconds).success ||
    !SECONDS.safeParse(options.adjudicationSeconds).success
  )
    fail('STORAGE_CONTRACT');
  const body = input.data as NonNullable<typeof input.data>;
  const authority = async () => {
    try {
      return await lockPracticeTrialParticipant(tx, actor);
    } catch (error) {
      return normalize(error);
    }
  };
  const participant = await authority();
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'FileSkillAssessmentAppeal',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: body,
    },
    async ({ receiptId }) => {
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      const ref = body.expectedAssessmentReference;
      if (!z.uuid().safeParse(ref.recordId).success) fail('NOT_FOUND');
      const found = await query<{ skillId: string }>(
        tx,
        'SELECT "skillId" FROM "SkillAssessment" WHERE "id"=$1::uuid AND "participantId"=$2::uuid',
        [ref.recordId, participant.id],
      );
      if (found.length !== 1) fail('NOT_FOUND');
      await lockAssessment(tx, participant.id, found[0].skillId);
      await authority();
      const current = await query<{
        versionId: string;
        revision: number;
        withinWindow: boolean;
        decisionNoticeAt: unknown;
        filedAt: unknown;
      }>(
        tx,
        `SELECT v."id"::text AS "versionId",v."revision",(v."issuedAt"+make_interval(secs=>$3::int)>=date_trunc('milliseconds',clock_timestamp())) AS "withinWindow",v."issuedAt" AS "decisionNoticeAt",date_trunc('milliseconds',clock_timestamp()) AS "filedAt" FROM "SkillAssessment" a JOIN "SkillAssessmentVersion" v ON v."id"=a."currentVersionId" WHERE a."id"=$1::uuid AND a."participantId"=$2::uuid`,
        [ref.recordId, participant.id, String(options.filingWindowSeconds)],
      );
      if (current.length !== 1) fail('STORAGE_CONTRACT');
      if (current[0].revision !== ref.revision) fail('REVISION_CHANGED');
      if (current[0].withinWindow !== true) fail('WINDOW_CLOSED');
      const existing = await query(
        tx,
        'SELECT 1 FROM "SkillAssessmentAppeal" WHERE "assessmentVersionId"=$1::uuid',
        [current[0].versionId],
      );
      if (existing.length) fail('APPEAL_EXISTS');
      const filedAt = instant(current[0].filedAt);
      const inserted = await query<{ id: string }>(
        tx,
        `INSERT INTO "SkillAssessmentAppeal" ("assessmentVersionId","participantId","appellantAccountId","reasonCategory","statement","decisionNoticeAt","filingDeadlineAt","filedAt","adjudicationDueAt","receiptId","requestId") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::timestamptz,$6::timestamptz+make_interval(secs=>$7::int),$8::timestamptz,$8::timestamptz+make_interval(secs=>$9::int),$10::uuid,$11) ON CONFLICT DO NOTHING RETURNING "id"::text AS "id"`,
        [
          current[0].versionId,
          participant.id,
          actor.accountId,
          body.reasonCategory,
          body.statement,
          instant(current[0].decisionNoticeAt),
          String(options.filingWindowSeconds),
          filedAt,
          String(options.adjudicationSeconds),
          receiptId,
          command.requestId,
        ],
      );
      if (inserted.length === 0) fail('APPEAL_EXISTS');
      if (inserted.length !== 1 || !z.uuid().safeParse(inserted[0].id).success)
        fail('STORAGE_CONTRACT');
      return {
        resultRef: inserted[0].id,
        events: [
          {
            type: 'skill.assessment_appeal_filed.v1',
            aggregateId: inserted[0].id,
            aggregateVersion: 1,
            payload: {
              skillAssessmentAppealId: inserted[0].id,
              skillAssessmentVersionId: current[0].versionId,
            },
            publish: false,
          },
        ],
      };
    },
  );
  await authority();
  if (!z.uuid().safeParse(result.resultRef).success) fail('STORAGE_CONTRACT');
  return Object.freeze({
    status: result.status,
    appeal: await loadView(tx, result.resultRef as string, participant.id),
  });
}

/**
 * An independent adjudicator decides one pending appeal once (DEC-2026-11-13-12 / -14-11). The adjudicator must be on
 * the host's dedicated allowlist and must not be the appellant, an original reviewer, or related to the appellant
 * through a Guild; every check is repeated after the locks. Upholding records that a fresh review by someone other
 * than the original reviewers is required; it never edits the assessment, grants a rank or moves anything else.
 * A decided appeal is final for that decision version.
 */
export async function adjudicateSkillAssessmentAppeal(
  tx: CommandReceiptTransaction,
  command: SkillAppealCommand,
  options: AdjudicateSkillAssessmentAppealOptions,
): Promise<SkillAssessmentAppealResult> {
  const actor = validCommand(command);
  const input = AdjudicateSkillAssessmentAppealInputSchema.safeParse(command.input);
  if (!input.success) fail('INVALID_INPUT');
  if (typeof options?.allowNewWrites !== 'boolean' || typeof options.isAdjudicator !== 'function')
    fail('STORAGE_CONTRACT');
  const body = input.data as NonNullable<typeof input.data>;
  const authority = async () => {
    try {
      await lockSkillStorageActor(tx, actor);
    } catch (error) {
      return normalize(error);
    }
  };
  const allowlisted = () => {
    try {
      return options.isAdjudicator(actor.accountId) === true;
    } catch {
      return fail('STORAGE_UNAVAILABLE');
    }
  };
  await authority();
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'AdjudicateSkillAssessmentAppeal',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: body,
    },
    async ({ receiptId }) => {
      if (!options.allowNewWrites) fail('WRITES_DISABLED');
      // Not being an adjudicator is answered before any case fact is read, so an outsider learns nothing of the case.
      if (!allowlisted()) fail('FORBIDDEN');
      const located = await query<{
        participantId: string;
        skillId: string;
      }>(
        tx,
        'SELECT a."participantId"::text AS "participantId",v."skillId" FROM "SkillAssessmentAppeal" a JOIN "SkillAssessmentVersion" v ON v."id"=a."assessmentVersionId" WHERE a."id"=$1::uuid',
        [body.appealId],
      );
      if (located.length !== 1) fail('NOT_FOUND');
      await lockAssessment(tx, located[0].participantId, located[0].skillId);
      await authority();
      if (!allowlisted()) fail('FORBIDDEN');
      const state = await query<{
        appellantAccountId: string;
        assessmentId: string;
        decided: boolean;
      }>(
        tx,
        'SELECT a."appellantAccountId",v."assessmentId"::text AS "assessmentId",EXISTS(SELECT 1 FROM "SkillAssessmentAppealDecision" d WHERE d."appealId"=a."id") AS "decided" FROM "SkillAssessmentAppeal" a JOIN "SkillAssessmentVersion" v ON v."id"=a."assessmentVersionId" WHERE a."id"=$1::uuid FOR UPDATE OF a',
        [body.appealId],
      );
      if (state.length !== 1) fail('STORAGE_CONTRACT');
      if (state[0].decided) fail('ALREADY_DECIDED');
      const reviewers = await query<{ accountId: string }>(
        tx,
        `SELECT DISTINCT x."accountId" FROM (
           SELECT v."evaluatorAccountId" AS "accountId" FROM "SkillAssessmentVersion" v WHERE v."assessmentId"=$1::uuid
           UNION SELECT d."evaluatorAccountId" FROM "PracticeAssessmentDecision" d WHERE d."assessmentId"=$1::uuid
           UNION SELECT g."evaluatorAccountId" FROM "PracticeTrialReviewAssignment" g WHERE g."submissionId" IN (SELECT v."submissionId" FROM "SkillAssessmentVersion" v WHERE v."assessmentId"=$1::uuid)
           UNION SELECT r."evaluatorAccountId" FROM "PracticeAssessmentReviewVersion" r WHERE r."submissionId" IN (SELECT v."submissionId" FROM "SkillAssessmentVersion" v WHERE v."assessmentId"=$1::uuid)
         ) x ORDER BY 1`,
        [state[0].assessmentId],
      );
      const guilds = await query<{ guildId: string }>(
        tx,
        `WITH "related" AS (
           SELECT g."id" AS "guildId",g."founderAccountId" AS "accountId" FROM "Guild" g
           UNION SELECT r."guildId",r."granteeAccountId" FROM "GuildRoleGrant" r WHERE r."revokedAt" IS NULL AND r."validFrom"<=clock_timestamp() AND (r."expiresAt" IS NULL OR r."expiresAt">clock_timestamp())
         ) SELECT DISTINCT a."guildId"::text AS "guildId" FROM "related" a JOIN "related" b ON b."guildId"=a."guildId" WHERE a."accountId"=$1 AND b."accountId"=$2`,
        [actor.accountId, state[0].appellantAccountId],
      );
      const verdict = evaluateAppealAdjudicator({
        version: 'v1',
        adjudicatorAccountId: actor.accountId,
        appellantAccountId: state[0].appellantAccountId,
        originalReviewerAccountIds: reviewers.map((r) => r.accountId),
        sharedGuildIds: guilds.map((g) => g.guildId),
        onAllowlist: true,
      });
      if (!verdict.allowed)
        fail(
          verdict.reason === 'SELF_ADJUDICATION'
            ? 'SELF_ADJUDICATION'
            : verdict.reason === 'ORIGINAL_REVIEWER'
              ? 'ORIGINAL_REVIEWER'
              : verdict.reason === 'GUILD_RELATIONSHIP'
                ? 'GUILD_RELATIONSHIP'
                : 'FORBIDDEN',
        );
      const excluded = body.outcome === 'UPHELD' ? reviewers.map((r) => r.accountId) : [];
      if (body.outcome === 'UPHELD' && excluded.length === 0) fail('STORAGE_CONTRACT');
      const inserted = await query<{ id: string }>(
        tx,
        'INSERT INTO "SkillAssessmentAppealDecision" ("appealId","outcome","adjudicatorAccountId","reason","freshReviewExcludedAccountIds","receiptId","requestId") VALUES ($1::uuid,$2,$3,$4,$5::text[],$6::uuid,$7) RETURNING "id"::text AS "id"',
        [
          body.appealId,
          body.outcome,
          actor.accountId,
          body.reason,
          '{' + excluded.map((id) => JSON.stringify(id)).join(',') + '}',
          receiptId,
          command.requestId,
        ],
      );
      if (inserted.length !== 1) fail('STORAGE_CONTRACT');
      return {
        resultRef: body.appealId,
        events: [
          {
            type: 'skill.assessment_appeal_decided.v1',
            aggregateId: body.appealId,
            aggregateVersion: 2,
            payload: { skillAssessmentAppealId: body.appealId },
            publish: false,
          },
        ],
      };
    },
  );
  await authority();
  if (result.resultRef !== body.appealId) fail('STORAGE_CONTRACT');
  return Object.freeze({
    status: result.status,
    appeal: await loadView(tx, body.appealId, null),
  });
}

/**
 * Pending appeals past their adjudication target, oldest first, as ids and seconds only (no account, statement or
 * evaluator). A trusted operator-side caller (an alert pass) supplies the transaction; this decides nothing and an
 * overdue appeal stays pending: no automatic outcome (DEC-2026-11-13-12 (b)).
 */
export async function listOverdueSkillAssessmentAppeals(
  tx: CommandReceiptTransaction,
  options: { readonly limit: number },
): Promise<readonly OverdueSkillAssessmentAppeal[]> {
  const limit = z.number().int().min(1).max(1000).safeParse(options?.limit);
  if (!limit.success) fail('INVALID_INPUT');
  const rows = await query<{
    appealId: string;
    adjudicationDueAt: unknown;
    overdueSeconds: number;
  }>(
    tx,
    `SELECT a."id"::text AS "appealId",a."adjudicationDueAt",floor(extract(epoch FROM clock_timestamp()-a."adjudicationDueAt"))::int AS "overdueSeconds" FROM "SkillAssessmentAppeal" a WHERE a."adjudicationDueAt"<clock_timestamp() AND NOT EXISTS(SELECT 1 FROM "SkillAssessmentAppealDecision" d WHERE d."appealId"=a."id") ORDER BY a."adjudicationDueAt",a."id" LIMIT $1::int`,
    [String(limit.data)],
  );
  return Object.freeze(
    rows.map((r) =>
      Object.freeze({
        appealId: r.appealId,
        adjudicationDueAt: instant(r.adjudicationDueAt),
        overdueSeconds: Number(r.overdueSeconds),
      }),
    ),
  );
}
