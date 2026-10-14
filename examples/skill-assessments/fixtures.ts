export const now = '2026-10-14T15:00:00.000Z';
export const until = '2026-10-14T15:01:00.000Z';
const reference = { recordId: 'synthetic-frontend-trial', revision: 2 };
const rubricReference = { recordId: 'synthetic-rubric', revision: 3 };
export const definition = {
  version: 'v1',
  reference,
  state: 'PUBLISHED',
  publishedAt: '2026-10-13T00:00:00.000Z',
  purpose: 'UNPAID_PLATFORM_PRACTICE',
  skillId: 'frontend',
  skillDomain: 'web',
  targetRank: 'A',
  title: 'Synthetic interface exercise',
  brief: 'Build and explain a synthetic accessible interface.',
  variantId: 'synthetic-variant-two',
  inputs: [{ label: 'Fixture', material: 'SYNTHETIC', content: 'Invented records only.' }],
  tools: {
    permitted: ['editor', 'browser'],
    aiAssistance: 'ALLOWED',
    disclosure: 'Explain and modify your work; disclose assistance.',
  },
  expectedMinutes: 60,
  rubric: {
    reference: rubricReference,
    criteria: [
      { id: 'behavior', description: 'Working behavior and edge cases', required: true },
      { id: 'ownership', description: 'Explain and modify the solution', required: true },
    ],
  },
  evaluatorMethod: 'MANUAL',
  passConditions: 'The authorized reviewer applies every required criterion.',
  maximumAttempts: 3,
  cooldownSeconds: 60,
  accommodationPolicy: 'Request an approved scoped accommodation.',
};
export const taxonomy = {
  version: 'v1',
  id: 'synthetic-catalog',
  revision: 1,
  state: 'PUBLISHED',
  publishedByAccountId: 'admin',
  publishedAt: '2026-10-13T00:00:00.000Z',
  skills: [
    { id: 'frontend', domain: 'web', name: 'Frontend', status: 'ACTIVE', aliases: ['frontend'] },
  ],
};

export const participant = {
  kind: 'HUMAN',
  id: 'synthetic-alice-participant',
  accountId: 'synthetic-alice-account',
};
export const assessmentReference = { recordId: 'synthetic-assessment', revision: 2 };
export const submissionReference = { recordId: 'synthetic-submission', revision: 4 };
export const evidenceReferences = [{ recordId: 'synthetic-owned-evidence', revision: 3 }];
export const previousAssessment = () => ({
  version: 'v1',
  reference: { ...assessmentReference },
  participantId: participant.id,
  skillId: definition.skillId,
  skillDomain: definition.skillDomain,
  state: 'VERIFIED',
  assessedRank: 'B',
  definitionReference: { ...reference },
  rubricReference: { ...rubricReference },
  submissionReference: { ...submissionReference },
  evidenceReferences: structuredClone(evidenceReferences),
  assessmentPolicyVersion: 'synthetic-policy-old',
  evaluatorAccountId: 'synthetic-old-reviewer',
  issuedAt: '2026-10-13T01:00:00.000Z',
  reassessmentAt: null,
  confidenceStatement: 'Relevant owned samples reviewed.',
  sampleSize: 2,
});
export const assessmentObservation = () => ({
  status: 'CURRENT',
  participantId: participant.id,
  skillId: definition.skillId,
  observedAt: now,
  validUntil: until,
  record: null,
});
export const commonContext = () => ({
  version: 'v1',
  now,
  actorAccountId: 'synthetic-reviewer',
  actorSessionAuthorized: true,
  actorRestricted: false,
  subject: { ...participant },
  taxonomy: structuredClone(taxonomy),
  assessmentRecordId: assessmentReference.recordId,
  assessmentPolicyVersion: 'synthetic-policy-current',
  assessmentObservation: assessmentObservation(),
});
export const reviewContext = () => ({
  ...commonContext(),
  definition: structuredClone(definition),
  submission: {
    version: 'v1',
    reference: { ...submissionReference },
    participantId: participant.id,
    definitionReference: { ...reference },
    state: 'SUBMITTED',
    submittedAt: '2026-10-14T14:59:00.000Z',
    observedAt: now,
    validUntil: until,
    evidenceReferences: structuredClone(evidenceReferences),
    ownership: 'CONFIRMED',
    sampleSize: 2,
  },
});
export const reviewInput = () => ({
  version: 'v1',
  expectedDefinitionReference: { ...reference },
  expectedRubricReference: { ...rubricReference },
  expectedSubmissionReference: { ...submissionReference },
  expectedAssessmentReference: null,
  decision: 'VERIFY',
  reason: 'Reviewed relevant working behavior and explanation.',
  confidenceStatement: 'Two relevant samples and ownership checks support this scoped target.',
  criteria: definition.rubric.criteria.map((c) => ({
    criterionId: c.id,
    result: 'MET',
    reason: 'Observed and reviewed relevant evidence.',
  })),
  reassessmentAt: null,
});
export const reassessmentContext = () => ({
  ...commonContext(),
  assessmentObservation: { ...assessmentObservation(), record: previousAssessment() },
  caseEvidence: {
    status: 'CURRENT',
    participantId: participant.id,
    assessmentReference: { ...assessmentReference },
    observedAt: now,
    validUntil: until,
    evidenceReferences: [{ recordId: 'synthetic-case-evidence', revision: 1 }],
  },
});
export const reassessmentInput = () => ({
  version: 'v1',
  expectedAssessmentReference: { ...assessmentReference },
  action: 'REQUIRE_REASSESSMENT',
  reasonCategory: 'CAPABILITY_RECHECK',
  reason: 'Relevant capability needs fresh review under the approved policy.',
  dueAt: '2026-10-15T15:00:00.000Z',
});
