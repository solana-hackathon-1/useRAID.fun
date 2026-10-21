import { reviewViewFixture as review } from './practice-review-view-fixture';
import { PracticeOwnershipContextSchema } from '../../src/skills/practice-ownership-context';
export const ownershipContextFixture = {
  ...PracticeOwnershipContextSchema.parse({
    version: 'v1',
    review,
    ownership: null,
    policy: {
      version: 'v1',
      private: true,
      accessId: crypto.randomUUID(),
      isAuthorizationToken: false,
      policy: {
        version: 'v1',
        id: crypto.randomUUID(),
        reference: { recordId: 'synthetic-policy', revision: 1 },
        definitionReference: review.definition.reference,
        rubricReference: review.definition.rubric.reference,
        skillId: review.definition.skillId,
        skillDomain: review.definition.skillDomain,
        targetRank: review.definition.targetRank,
        purpose: 'OWNERSHIP_REVIEW',
        state: 'APPROVED',
        guidance: '<script>private-policy-marker</script>',
        publishedByAccountId: 'issuer',
        publishedAt: '2026-10-21T00:00:00.000Z',
        persisted: true,
        verifiesSkill: false,
        confirmsOwnership: false,
        createsPermissionGrant: false,
        isAuthorizationToken: false,
        consumesCapacity: false,
        createsFinancialObligation: false,
      },
    },
  }),
  writesAvailable: true,
};
