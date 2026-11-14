import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import { SkillRankSchema } from '../contracts/entities';
import type { WorkHost } from './contracts';

/** A skill record the host read for the applicant: the host's own source of truth, never caller supplied. */
export const SkillRecordSchema = z.strictObject({
  skillId: InternalId,
  rank: SkillRankSchema,
  status: z.enum(['VERIFIED', 'REASSESSMENT_REQUIRED', 'REVOKED']),
  assessedAt: UtcTimestamp,
});
export type SkillRecord = z.infer<typeof SkillRecordSchema>;

export interface EvidenceSnapshotHost {
  /** Default off. Taking a snapshot is a new write; withdrawing one never consults it. */
  allowNewWrites: boolean;
  /** Current scoped Guild authority to manage the listing (the same contract as `WorkHost.authorize`). */
  authorize: WorkHost['authorize'];
  /**
   * The applicant's own skill records for exactly `skillIds`, read inside the given transaction. Only the Raid's
   * required skills the applicant chose are ever asked for. Return nothing for a skill with no record. The host must not
   * return evidence content, files, links, other skills or anything about other Guilds.
   */
  readSkillRecords(
    tx: Parameters<WorkHost['authorize']>[0],
    subject: { accountId: string; participantId: string },
    skillIds: readonly string[],
  ): Promise<readonly SkillRecord[]>;
}

/** One shared skill as the reviewer sees it. A relevant skill with no record is NOT_ASSESSED, never a guessed rank. */
export const SnapshotSkillSchema = z
  .strictObject({
    skillId: InternalId,
    rank: SkillRankSchema.nullable(),
    status: z.enum(['VERIFIED', 'REASSESSMENT_REQUIRED', 'REVOKED', 'NOT_ASSESSED']),
    assessedAt: UtcTimestamp.nullable(),
  })
  .refine(
    (s) => (s.status === 'NOT_ASSESSED') === (s.rank === null && s.assessedAt === null),
    'A not-assessed skill carries no rank or date, and an assessed one carries both.',
  );
export const EvidenceSnapshotSchema = z.strictObject({
  id: z.uuid(),
  applicationId: z.uuid(),
  takenAt: UtcTimestamp,
  skills: z.array(SnapshotSkillSchema).min(1).max(50),
});
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;

const unique = (v: { sharedSkillIds: readonly string[] }) =>
  new Set(v.sharedSkillIds).size === v.sharedSkillIds.length;
const sharedSkillIds = z.array(InternalId).min(1).max(50);
/** The HTTP body: the application comes from the path. Applying shares nothing; this is the explicit consent. */
export const RecordEvidenceSnapshotBody = z
  .strictObject({ sharedSkillIds, consent: z.literal(true) })
  .refine(unique, 'Duplicate skill.');
export const RecordEvidenceSnapshotInput = z
  .strictObject({ applicationId: z.uuid(), sharedSkillIds, consent: z.literal(true) })
  .refine(unique, 'Duplicate skill.');
export const WithdrawEvidenceSnapshotInput = z.strictObject({ applicationId: z.uuid() });

export const EvidenceSnapshotResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  snapshot: EvidenceSnapshotSchema,
});
export const EvidenceSnapshotWithdrawalResultSchema = z.strictObject({
  status: z.enum(['EXECUTED', 'REPLAYED']),
  applicationId: z.uuid(),
  withdrawnAt: UtcTimestamp,
});
/**
 * What a caller may see. `snapshot` is present only while `availability` is SHARED, for both roles. The reviewer
 * never learns more than the snapshot and is only ever told SHARED or NOT_SHARED; WITHDRAWN and CLOSED are for the applicant.
 */
export const EvidenceSnapshotViewSchema = z
  .strictObject({
    version: z.literal('v1'),
    role: z.enum(['APPLICANT', 'REVIEWER']),
    applicationId: z.uuid(),
    availability: z.enum(['SHARED', 'NOT_SHARED', 'WITHDRAWN', 'CLOSED']),
    snapshot: EvidenceSnapshotSchema.nullable(),
  })
  .refine((v) => (v.availability === 'SHARED') === (v.snapshot !== null));
export type EvidenceSnapshotView = z.infer<typeof EvidenceSnapshotViewSchema>;
