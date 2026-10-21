import { z } from 'zod';
import {
  readPracticeTrialForReview,
  ReadPracticeReviewInputSchema,
  PracticeReviewReadRecordSchema,
} from './practice-review-read-storage';
import {
  observeApprovedPracticeReviewPolicy,
  PracticeReviewPolicyViewSchema,
} from './practice-review-policy-storage';
import {
  readPracticeTrialOwnership,
  PracticeTrialOwnershipError,
} from './practice-trial-ownership-storage';
import { PracticeTrialOwnershipViewSchema } from './practice-trial-ownership-contracts';
import { lockPracticeReviewAssignment } from './practice-review-assignment-storage';
import type { SkillTaxonomyActor } from './taxonomy-storage-contracts';
import type { CommandReceiptTransaction } from '../command-receipts';
const same = (
  a: { recordId: string; revision: number },
  b: { recordId: string; revision: number },
) => a.recordId === b.recordId && a.revision === b.revision;
export const PracticeOwnershipContextSchema = z
  .strictObject({
    version: z.literal('v1'),
    review: PracticeReviewReadRecordSchema,
    policy: PracticeReviewPolicyViewSchema.nullable(),
    ownership: PracticeTrialOwnershipViewSchema.nullable(),
  })
  .refine((c) => {
    const { review: r, policy: p, ownership: o } = c;
    return (
      r.assignment.purpose === 'OWNERSHIP_REVIEW' &&
      (!p ||
        (p.policy.state === 'APPROVED' &&
          p.policy.purpose === 'OWNERSHIP_REVIEW' &&
          same(p.policy.definitionReference, r.definition.reference) &&
          same(p.policy.rubricReference, r.definition.rubric.reference) &&
          p.policy.skillId === r.definition.skillId &&
          p.policy.skillDomain === r.definition.skillDomain &&
          p.policy.targetRank === r.definition.targetRank)) &&
      (!o ||
        (o.isCurrent &&
          same(o.record.submissionReference, r.submission.reference) &&
          same(o.record.definitionReference, r.definition.reference) &&
          same(o.record.rubricReference, r.definition.rubric.reference) &&
          o.record.participantId === r.submission.participantId &&
          o.record.skillId === r.definition.skillId &&
          o.record.skillDomain === r.definition.skillDomain))
    );
  })
  .readonly();
export type PracticeOwnershipContext = z.output<typeof PracticeOwnershipContextSchema> & {
  readonly writesAvailable: boolean;
};
/** One transaction: original case, approved policy, current finding, final finite assignment check. */
export async function readPracticeOwnershipContext(
  tx: CommandReceiptTransaction,
  actor: SkillTaxonomyActor,
  inputValue: unknown,
  enabled: () => boolean,
) {
  const input = ReadPracticeReviewInputSchema.safeParse(inputValue);
  if (!input.success || input.data.purpose !== 'OWNERSHIP_REVIEW')
    throw new PracticeTrialOwnershipError('INVALID_INPUT');
  const scope = input.data;
  const review = await readPracticeTrialForReview(tx, actor, scope, enabled);
  if (!review) return null;
  const policy = await observeApprovedPracticeReviewPolicy(tx, actor, scope, enabled);
  const ownership = await readPracticeTrialOwnership(tx, actor, scope, enabled);
  const finalGrant = await lockPracticeReviewAssignment(
    tx,
    actor,
    { assignmentId: scope.assignmentId, submissionId: scope.submissionId, purpose: scope.purpose },
    enabled,
  );
  if (!finalGrant || !enabled()) return null;
  const result = PracticeOwnershipContextSchema.safeParse({
    version: 'v1',
    review,
    policy,
    ownership,
  });
  if (
    !result.success ||
    review.assignment.id !== scope.assignmentId ||
    review.submission.reference.recordId !== scope.submissionId ||
    review.assignment.evaluatorAccountId !== actor.accountId
  )
    throw new PracticeTrialOwnershipError('STORAGE_CONTRACT');
  return result.data;
}
