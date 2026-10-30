import { z } from 'zod';
import type { CommandReceiptTransaction } from '../command-receipts';
import { SkillTaxonomyActorSchema, type SkillTaxonomyActor } from './taxonomy-storage';
import type { PracticeReviewAssignmentUseScope } from './practice-review-assignment-storage';
import {
  lockPracticeReviewReadPermission,
  PracticeReviewReadError,
  ReadPracticeReviewInputSchema,
} from './practice-review-read-storage';

/**
 * Advisory reviewer hint only (blueprint 07.5/09.7): the subject's current claim for the reviewed skill
 * shares normalized portfolio references with another participant's current claim. It is not a verdict,
 * restriction, rank input or authorization, and it never identifies the other participant.
 */
export const EvidenceReuseSignalSchema = z
  .strictObject({
    version: z.literal('v1'),
    private: z.literal(true),
    advisory: z.literal(true),
    possibleReuse: z.boolean(),
    otherParticipantCount: z.number().int().min(0).max(1000000),
    matchedReferenceCount: z.number().int().min(0).max(5),
    automaticRestriction: z.literal(false),
    isAuthorizationToken: z.literal(false),
  })
  .refine((v) => v.possibleReuse === v.otherParticipantCount > 0)
  .refine((v) => v.matchedReferenceCount > 0 === v.possibleReuse)
  .readonly();
export type EvidenceReuseSignal = z.output<typeof EvidenceReuseSignalSchema>;

function fail(code: PracticeReviewReadError['code']): never {
  throw new PracticeReviewReadError(code);
}
/**
 * Same held transaction and authority as the private reviewer read: current assignment, purpose and scope
 * before and after the lookup. Null for every missing, foreign, expired, revoked or out-of-scope case.
 */
export async function readEvidenceReuseForReview(
  tx: CommandReceiptTransaction,
  actorValue: SkillTaxonomyActor,
  inputValue: unknown,
  canRead: (scope: PracticeReviewAssignmentUseScope) => boolean,
): Promise<EvidenceReuseSignal | null> {
  const actor = SkillTaxonomyActorSchema.safeParse(actorValue),
    input = ReadPracticeReviewInputSchema.safeParse(inputValue);
  if (!actor.success || !input.success) fail('INVALID_INPUT');
  if (typeof canRead !== 'function') fail('STORAGE_CONTRACT');
  const assignment = await lockPracticeReviewReadPermission(tx, actor.data, input.data, canRead);
  if (!assignment) return null;
  let rows: { matched: number; others: number }[];
  try {
    rows = await tx.query<{ matched: number; others: number }>(
      `SELECT count(DISTINCT mine."fingerprint")::int AS matched,count(DISTINCT other."participantId")::int AS others
 FROM "PracticeTrialSubmission" s
 JOIN "PracticeTrialStart" a ON a."id"=s."startId"
 JOIN "PracticeTrialVersion" d ON d."id"=a."definitionVersionId"
 JOIN "SkillClaim" c ON c."participantId"=s."participantId" AND c."skillId"=d."definition"->>'skillId'
 JOIN "SkillEvidenceFingerprint" mine ON mine."skillClaimVersionId"=c."currentVersionId"
 JOIN "SkillEvidenceFingerprint" shared ON shared."fingerprintVersion"=mine."fingerprintVersion" AND shared."fingerprint"=mine."fingerprint" AND shared."skillClaimVersionId"<>mine."skillClaimVersionId"
 JOIN "SkillClaim" other ON other."currentVersionId"=shared."skillClaimVersionId" AND other."participantId"<>s."participantId"
 WHERE s."id"=$1::uuid`,
      [assignment.submissionId],
    );
  } catch {
    return fail('STORAGE_UNAVAILABLE');
  }
  if (!Array.isArray(rows) || rows.length !== 1) fail('STORAGE_CONTRACT');
  const current = await lockPracticeReviewReadPermission(tx, actor.data, input.data, canRead);
  if (!current) return null;
  const parsed = EvidenceReuseSignalSchema.safeParse({
    version: 'v1',
    private: true,
    advisory: true,
    possibleReuse: rows[0].others > 0,
    otherParticipantCount: rows[0].others,
    matchedReferenceCount: rows[0].matched,
    automaticRestriction: false,
    isAuthorizationToken: false,
  });
  if (!parsed.success) fail('STORAGE_CONTRACT');
  return parsed.data;
}
