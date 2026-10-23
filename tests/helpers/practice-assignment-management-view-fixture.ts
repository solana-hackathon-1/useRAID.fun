export const managementSubmissionId = '11111111-1111-4111-8111-111111111111';
export const managementAssignmentId = '22222222-2222-4222-8222-222222222222';
export const managementContext = {
  version: 'v1' as const,
  writesAvailable: true,
  unavailableReason: null,
  page: {
    version: 'v1' as const,
    private: true as const,
    isAuthorizationToken: false as const,
    accessId: '33333333-3333-4333-8333-333333333333',
    actorAccountId: 'manager-account',
    observedAt: '2026-10-23T12:00:00.000Z',
    submissionId: managementSubmissionId,
    after: null,
    entries: [
      {
        assignment: {
          version: 'v1' as const,
          id: managementAssignmentId,
          submissionId: managementSubmissionId,
          evaluatorAccountId: 'evaluator-account',
          purpose: 'OWNERSHIP_REVIEW' as const,
          expiresAt: '2030-01-01T00:00:00.000Z',
          issuedAt: '2026-10-23T11:00:00.000Z',
          issuedByAccountId: 'manager-account',
          reason: 'Original synthetic assignment.',
          state: 'ISSUED' as const,
          isAuthorizationToken: false as const,
        },
        revocation: null,
        currentState: 'ACTIVE' as const,
      },
    ],
    nextCursor: null,
  },
};
export const managementIssueFields = {
  submissionId: managementSubmissionId,
  evaluatorAccountId: 'evaluator-account',
  purpose: 'ASSESSMENT_REVIEW',
  expiresAt: '2030-01-01T00:00:00.000Z',
  reason: '  Synthetic finite review.  ',
};
