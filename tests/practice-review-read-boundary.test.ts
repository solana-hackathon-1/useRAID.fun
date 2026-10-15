import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  PracticeReviewReadRecordSchema,
  readPracticeTrialForReview,
} from '../src/skills/practice-review-read-storage';
import type { CommandReceiptTransaction } from '../src/command-receipts';
import { definition } from '../examples/skill-assessments/fixtures';
const submissionId = randomUUID();
const record = {
  version: 'v1',
  accessId: randomUUID(),
  private: true,
  isAuthorizationToken: false,
  assignment: {
    version: 'v1',
    id: randomUUID(),
    submissionId,
    evaluatorAccountId: 'reviewer',
    purpose: 'OWNERSHIP_REVIEW',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-10-15T00:00:00.000Z',
    issuedByAccountId: 'issuer',
    reason: 'Synthetic scoped review',
    state: 'ISSUED',
    isAuthorizationToken: false,
  },
  definition,
  submission: {
    version: 'v1',
    reference: { recordId: submissionId, revision: 1 },
    startId: randomUUID(),
    participantId: randomUUID(),
    skillId: definition.skillId,
    skillDomain: definition.skillDomain,
    definitionReference: definition.reference,
    rubricReference: definition.rubric.reference,
    state: 'SUBMITTED',
    submittedAt: '2026-10-15T00:00:00.000Z',
    answer: 'Literal private code',
    explanation: 'Synthetic explanation',
    toolsUsed: [],
    aiAssistanceUsed: false,
    assistanceDisclosure: 'None',
    ownership: 'UNCONFIRMED',
    persisted: true,
    verifiesSkill: false,
    isAuthorizationToken: false,
    createsPermissionGrant: false,
    consumesCapacity: false,
    createsFinancialObligation: false,
  },
};
it('accepts a coherent private historical unconfirmed review DTO', () => {
  expect(PracticeReviewReadRecordSchema.safeParse(record).success).toBe(true);
});
it.each([
  ['assignment submission', { assignment: { ...record.assignment, submissionId: randomUUID() } }],
  [
    'definition record',
    {
      submission: {
        ...record.submission,
        definitionReference: { ...definition.reference, recordId: 'another-definition' },
      },
    },
  ],
  [
    'definition revision',
    {
      submission: {
        ...record.submission,
        definitionReference: {
          ...definition.reference,
          revision: definition.reference.revision + 1,
        },
      },
    },
  ],
  [
    'rubric record',
    {
      submission: {
        ...record.submission,
        rubricReference: { ...definition.rubric.reference, recordId: 'another-rubric' },
      },
    },
  ],
  [
    'rubric revision',
    {
      submission: {
        ...record.submission,
        rubricReference: {
          ...definition.rubric.reference,
          revision: definition.rubric.reference.revision + 1,
        },
      },
    },
  ],
  ['skill', { submission: { ...record.submission, skillId: 'another-skill' } }],
  ['domain', { submission: { ...record.submission, skillDomain: 'another-domain' } }],
])('rejects a review DTO with mismatched %s', (_name, patch) => {
  expect(PracticeReviewReadRecordSchema.safeParse({ ...record, ...patch }).success).toBe(false);
});
it.each([
  { private: false },
  { isAuthorizationToken: true },
  { submission: { ...record.submission, ownership: 'CONFIRMED' } },
  { submission: { ...record.submission, verifiesSkill: true } },
  { submission: { ...record.submission, assessedRank: 'S' } },
])('does not accept public/authorization/assessment claims %s', (patch) => {
  expect(PracticeReviewReadRecordSchema.safeParse({ ...record, ...patch }).success).toBe(false);
});
it('rejects forged identity and missing read policy before any query', async () => {
  let calls = 0;
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      calls++;
      return [];
    },
  };
  const actor = { accountId: 'self', sessionHash: 'a'.repeat(64) },
    input = {
      version: 'v1',
      assignmentId: randomUUID(),
      submissionId: randomUUID(),
      purpose: 'OWNERSHIP_REVIEW',
    };
  for (const field of ['role', 'participantId', 'canReview'])
    await expect(
      readPracticeTrialForReview(tx, { ...actor, [field]: 'forged' }, input, () => true),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    readPracticeTrialForReview(tx, actor, input, null as unknown as () => boolean),
  ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  expect(calls).toBe(0);
});
