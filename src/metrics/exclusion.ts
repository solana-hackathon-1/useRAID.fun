import { z } from 'zod';
import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { UtcTimestamp } from '../contracts/ids';
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
// Free text is an evidence reference (a ticket or review id), not a narrative: bounded, single-purpose, no controls.
const EvidenceRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}]*\S[^\p{Cc}]*$/u);
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
 * Appends one marker as `operatorAccountId`, which the host must already have authorized as an operator. A missing
 * subject is `SUBJECT_NOT_FOUND`; a first marker for a subject that has one, or a supersede of anything but the
 * current head of the same subject, is `CONFLICT` (also when two operators race: the database admits one).
 */
export async function setMetricsExclusion(
  tx: Tx,
  command: { operatorAccountId: string; input: unknown },
): Promise<MetricsExclusionRecord> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    throw new MetricsError('STORAGE_CONTRACT');
  const parsed = SetMetricsExclusionInputSchema.safeParse(command?.input);
  const actor = z.string().min(1).max(200).safeParse(command?.operatorAccountId);
  if (!parsed.success || !actor.success) throw new MetricsError('INVALID_INPUT');
  const input = parsed.data;
  // The table name comes from a closed map, never from input.
  const found = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok FROM "${SUBJECT_TABLE[input.subjectType]}" WHERE "id"::text=$1`,
    [input.subjectId],
  );
  if (!found.length) throw new MetricsError('SUBJECT_NOT_FOUND');
  const inserted = await tx.query<Row>(
    `INSERT INTO "MetricsExclusion"
       ("subjectType","subjectId","reason","evidenceRef","effect","supersedesMarkerId","actorAccountId")
     SELECT $1,$2,$3,$4,$5,$6::uuid,$7
     WHERE $6::uuid IS NULL OR EXISTS (
       SELECT 1 FROM "MetricsExclusion" head WHERE head."id"=$6::uuid AND head."subjectType"=$1 AND head."subjectId"=$2)
     ON CONFLICT DO NOTHING
     RETURNING "id","subjectType","subjectId","reason","evidenceRef","effect","supersedesMarkerId","actorAccountId","recordedAt"`,
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
  const row = inserted[0];
  return MetricsExclusionRecordSchema.parse({
    ...row,
    recordedAt: new Date(row.recordedAt).toISOString(),
  });
}
