import type { CommandReceiptTransaction } from '../command-receipts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * True only when `policyVersionId` is the CURRENT, APPROVED ASSESSMENT_REVIEW policy version for this skill of this
 * taxonomy. That is the exact id a verified assessment records, so a requirement naming anything else (a label, an
 * ownership-review policy, another skill's policy, a withdrawn or superseded revision) could never be met. It answers
 * existence only and returns no policy content; a malformed id is simply "no".
 */
export async function isPublishedAssessmentPolicy(
  tx: CommandReceiptTransaction,
  scope: { policyVersionId: string; skillId: string; taxonomyId: string },
): Promise<boolean> {
  if (!UUID.test(scope.policyVersionId)) return false;
  const rows = await tx.query(
    `SELECT 1 FROM "PracticeReviewPolicyVersion" v
       JOIN "PracticeReviewPolicy" p ON p."id"=v."policyId" AND p."currentVersionId"=v."id"
       JOIN "PracticeTrialVersion" d ON d."id"=v."definitionVersionId"
      WHERE v."id"=$1::uuid AND v."state"='APPROVED' AND v."purpose"='ASSESSMENT_REVIEW'
        AND d."skillId"=$2 AND d."taxonomyId"=$3`,
    [scope.policyVersionId.toLowerCase(), scope.skillId, scope.taxonomyId],
  );
  return rows.length === 1;
}
