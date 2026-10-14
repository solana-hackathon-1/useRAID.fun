import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparePracticeTrialAttempt, readPracticeTrial } from './skills/practice-trials';
import {
  PracticeTrialDefinitionSchema,
  type PracticeTrialPolicy,
} from './skills/practice-trial-contracts';
const now = '2026-10-14T15:00:00.000Z';
const until = '2026-10-14T15:01:00.000Z';
const reference = { recordId: 'synthetic-frontend-trial', revision: 2 };
const rubricReference = { recordId: 'synthetic-rubric', revision: 3 };
const definition = {
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
const taxonomy = {
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
const discovery = () => ({ version: 'v1', now, taxonomy, definition: structuredClone(definition) });
const context = () => ({
  ...discovery(),
  actorAccountId: 'alice-account',
  actorSessionAuthorized: true,
  actorRestricted: false,
  participant: { kind: 'HUMAN', id: 'alice-participant', accountId: 'alice-account' },
  attemptHistory: {
    status: 'CURRENT',
    participantId: 'alice-participant',
    trialId: reference.recordId,
    observedAt: now,
    validUntil: until,
    attemptsUsed: 0,
    lastAttemptAt: null,
  },
  accommodation: null,
});
const input = () => ({
  version: 'v1',
  definitionReference: { ...reference },
  accommodationReference: null,
});
const grant = () => ({
  version: 'v1',
  reference: { recordId: 'synthetic-accommodation', revision: 1 },
  participantId: 'alice-participant',
  definitionReference: { ...reference },
  observedAt: now,
  validUntil: until,
  maximumAttempts: 5,
  expectedMinutes: 90,
  cooldownSeconds: 0,
});

// Two deterministic local approval implementations use the entire normalized immutable record.
const approvedDefinition = PracticeTrialDefinitionSchema.parse(definition);
const expectedBytes = JSON.stringify(approvedDefinition);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const expectedDigest = digest(approvedDefinition);
const bytePolicy: PracticeTrialPolicy = {
  isApprovedDefinition: (value) => JSON.stringify(value) === expectedBytes,
  isApprovedAccommodation: () => false,
};
const digestPolicy: PracticeTrialPolicy = {
  isApprovedDefinition: (value) => digest(value) === expectedDigest,
  isApprovedAccommodation: () => false,
};
for (const policy of [bytePolicy, digestPolicy]) {
  const view = readPracticeTrial(discovery(), policy);
  assert.equal(view.targetRank, 'A');
  assert.equal(view.purpose, 'UNPAID_PLATFORM_PRACTICE');
  assert(Object.isFrozen(view.rubric.criteria[0]));
  const candidate = preparePracticeTrialAttempt(context(), input(), policy);
  assert.equal(candidate.attemptNumber, 1);
  assert.equal(candidate.verifiesSkill, false);
  assert.equal(candidate.persisted, false);
  assert.equal(candidate.consumesCapacity, false);
  assert.equal(candidate.createsFinancialObligation, false);
  assert.throws(
    () =>
      readPracticeTrial(
        {
          ...discovery(),
          definition: { ...definition, brief: 'Changed under the same approved ID' },
        },
        policy,
      ),
    /DEFINITION_UNAVAILABLE/,
  );
  assert.throws(
    () => preparePracticeTrialAttempt({ ...context(), actorAccountId: 'foreign' }, input(), policy),
    /FORBIDDEN/,
  );
  assert.throws(
    () =>
      preparePracticeTrialAttempt(
        { ...context(), attemptHistory: { status: 'UNAVAILABLE' } },
        input(),
        policy,
      ),
    /ATTEMPT_HISTORY_UNAVAILABLE/,
  );
}
const accommodation = grant();
const accommodated = preparePracticeTrialAttempt(
  { ...context(), accommodation },
  { ...input(), accommodationReference: accommodation.reference },
  {
    ...bytePolicy,
    isApprovedAccommodation: (value: unknown) =>
      JSON.stringify(value) === JSON.stringify(accommodation),
  },
);
assert.equal(accommodated.expectedMinutes, 90);
console.log(
  JSON.stringify({
    synthetic: true,
    alternateApprovalPorts: true,
    immutableDefinitionBinding: true,
    canonicalSubjectBinding: true,
    staleHistoryDenied: true,
    approvedAccommodation: true,
    noRankOrCapacityOrFinancialEffect: true,
  }),
);
