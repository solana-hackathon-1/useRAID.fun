import { z } from 'zod';
import {
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import { MetricsError } from './contracts';

/**
 * Metrics exclusion marker (DEC-2026-11-13-10, T043). An operator marks a record as excluded from product metrics. The
 * marker changes metrics only, never a work, reward, reputation or account record, and is never set automatically:
 * suspension and skill-evidence fingerprints are not markers. Markers are append-only: the first marker of a subject
 * has no predecessor, every later one supersedes the current head of that subject's chain (a new reason, or a RELEASE
 * that lifts the exclusion). The host decides who is an operator and passes the authorized account id; the database
 * additionally refuses an actor that is not an active administrator.
 */
export const METRICS_EXCLUSION_SUBJECTS = [
  'GUILD',
  'WORK_LISTING',
  'ENGAGEMENT',
  'PARTICIPANT',
] as const;
export const METRICS_EXCLUSION_REASONS = [
  'FIXTURE',
  'INTERNAL_DEMO',
  'SELF_DEALING',
  'DUPLICATE',
  'KNOWN_ABUSE',
] as const;
const SubjectId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const MarkerId = z.uuid();
// Evidence is an id or ticket reference, never free text: markers are append-only, so personal data or a secret stored
// here could never be removed. No whitespace, '@', control, bidi or zero-width character can match.
const EvidenceRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/);
export const SetMetricsExclusionInputSchema = z
  .strictObject({
    subjectType: z.enum(METRICS_EXCLUSION_SUBJECTS),
    subjectId: SubjectId,
    reason: z.enum(METRICS_EXCLUSION_REASONS),
    evidenceRef: EvidenceRef,
    effect: z.enum(['EXCLUDE', 'RELEASE']),
    supersedesMarkerId: MarkerId.nullable(),
  })
  .refine((input) => input.effect === 'EXCLUDE' || input.supersedesMarkerId !== null, {
    message: 'a release must name the marker it releases',
    path: ['supersedesMarkerId'],
  });
export type SetMetricsExclusionInput = z.infer<typeof SetMetricsExclusionInputSchema>;
export const MetricsExclusionRecordSchema = z.strictObject({
  id: MarkerId,
  subjectType: z.enum(METRICS_EXCLUSION_SUBJECTS),
  subjectId: SubjectId,
  reason: z.enum(METRICS_EXCLUSION_REASONS),
  evidenceRef: EvidenceRef,
  effect: z.enum(['EXCLUDE', 'RELEASE']),
  supersedesMarkerId: MarkerId.nullable(),
  actorAccountId: z.string().min(1).max(200),
  recordedAt: UtcTimestamp,
});
export type MetricsExclusionRecord = z.infer<typeof MetricsExclusionRecordSchema>;
export const MetricsExclusionOutcomeSchema = z.strictObject({
  /** `REPLAYED` when the same operator retried the same key and payload: the stored marker, nothing new. */
  status: z.enum(['EXECUTED', 'REPLAYED']),
  marker: MetricsExclusionRecordSchema,
});
export type MetricsExclusionOutcome = z.infer<typeof MetricsExclusionOutcomeSchema>;

const SUBJECT_TABLE: Record<(typeof METRICS_EXCLUSION_SUBJECTS)[number], string> = {
  GUILD: 'Guild',
  WORK_LISTING: 'WorkListing',
  ENGAGEMENT: 'Engagement',
  PARTICIPANT: 'Participant',
};
interface Row {
  id: string;
  subjectType: string;
  subjectId: string;
  reason: string;
  evidenceRef: string;
  effect: string;
  supersedesMarkerId: string | null;
  actorAccountId: string;
  recordedAt: Date;
}

/**
 * Appends one marker as `operatorAccountId`, which the host must already have authorized as an operator. The command
 * is idempotent per (operator, `idempotencyKey`): a retry returns the same marker with status `REPLAYED`, another payload under the same key is
 * `IDEMPOTENCY_KEY_REUSED`, and one private audit event records the operator, the marker and the request. A missing
 * subject is `SUBJECT_NOT_FOUND`; a first marker for a subject that has one, or a supersede of anything but the current
 * head of the same subject, is `CONFLICT` (also when two operators race: the database admits one).
 */
export async function setMetricsExclusion(
  tx: Tx,
  command: { operatorAccountId: string; input: unknown; idempotencyKey: string; requestId: string },
): Promise<MetricsExclusionOutcome> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    throw new MetricsError('STORAGE_CONTRACT');
  const parsed = SetMetricsExclusionInputSchema.safeParse(command?.input);
  const actor = InternalId.safeParse(command?.operatorAccountId);
  const key = InternalId.safeParse(command?.idempotencyKey);
  const request = InternalId.safeParse(command?.requestId);
  if (!parsed.success || !actor.success || !key.success || !request.success)
    throw new MetricsError('INVALID_INPUT');
  const input = parsed.data;
  // Same rule as the host's isAdmin (active ADMIN account with an X id; the environment allowlist is the host's), checked
  // before the receipt is claimed so a demoted operator cannot replay either. The actor trigger repeats it in the database.
  const operator = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok FROM "User" WHERE "id"=$1 AND "role"='ADMIN' AND NOT "suspended" AND "xId" IS NOT NULL AND "xId"<>''`,
    [actor.data],
  );
  if (!operator.length) throw new MetricsError('FORBIDDEN');
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.data,
      commandKind: 'SetMetricsExclusion',
      idempotencyKey: key.data,
      requestId: request.data,
      request: input,
    },
    async () => {
      // The table name comes from a closed map, never from input.
      const found = await tx.query<{ ok: number }>(
        `SELECT 1 AS ok FROM "${SUBJECT_TABLE[input.subjectType]}" WHERE "id"::text=$1`,
        [input.subjectId],
      );
      if (!found.length) throw new MetricsError('SUBJECT_NOT_FOUND');
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO "MetricsExclusion"
           ("subjectType","subjectId","reason","evidenceRef","effect","supersedesMarkerId","actorAccountId")
         SELECT $1,$2,$3,$4,$5,$6::uuid,$7
         WHERE $6::uuid IS NULL OR EXISTS (
           SELECT 1 FROM "MetricsExclusion" head WHERE head."id"=$6::uuid AND head."subjectType"=$1 AND head."subjectId"=$2)
         ON CONFLICT DO NOTHING
         RETURNING "id"::text AS "id"`,
        [
          input.subjectType,
          input.subjectId,
          input.reason,
          input.evidenceRef,
          input.effect,
          input.supersedesMarkerId,
          actor.data,
        ],
      );
      // No row: the predecessor is not this subject's marker, or a unique index refused a second root or a fork.
      if (inserted.length !== 1) throw new MetricsError('CONFLICT');
      const id = inserted[0].id;
      return {
        resultRef: id,
        // Private audit only (no outbox): who set which marker. The marker row carries the reason and evidence.
        events: [
          {
            type: 'work.metrics_exclusion_recorded.v1',
            aggregateId: id,
            aggregateVersion: 1,
            publish: false,
          },
        ],
      };
    },
  );
  const [row] = await tx.query<Row>(
    `SELECT "id"::text AS "id","subjectType","subjectId","reason","evidenceRef","effect",
       "supersedesMarkerId"::text AS "supersedesMarkerId","actorAccountId","recordedAt"
     FROM "MetricsExclusion" WHERE "id"=$1::uuid`,
    [result.resultRef],
  );
  if (!row) throw new MetricsError('STORAGE_CONTRACT');
  return {
    status: result.status,
    marker: MetricsExclusionRecordSchema.parse({
      ...row,
      recordedAt: new Date(row.recordedAt).toISOString(),
    }),
  };
}
