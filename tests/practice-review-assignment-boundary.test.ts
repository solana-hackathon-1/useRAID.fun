import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
import {
  issuePracticeReviewAssignment,
  revokePracticeReviewAssignment,
  lockPracticeReviewAssignment,
  type PracticeReviewAssignmentCommand,
  type PracticeReviewAssignmentOptions,
} from '../src/skills/practice-review-assignment-storage';
import type { CommandReceiptTransaction } from '../src/command-receipts';
const actor = { accountId: 'self', sessionHash: 'a'.repeat(64) };
const options = { allowNewWrites: true, canManage: () => true };
const command = {
  actor,
  input: {
    version: 'v1',
    submissionId: randomUUID(),
    evaluatorAccountId: 'reviewer',
    purpose: 'OWNERSHIP_REVIEW',
    expiresAt: '2030-01-01T00:00:00.000Z',
    reason: 'Synthetic reason',
  },
  idempotencyKey: 'key',
  requestId: 'r',
};
it.each(['practiceReviewAssignmentId', 'practiceReviewRevocationId'])(
  'accepts opaque %s private audit reference and no private body',
  (field) => {
    const event = {
      eventId: 'e',
      type: 'skill.practice_review_assignment_issued.v1',
      aggregateId: 'a',
      aggregateVersion: 1,
      occurredAt: '2026-10-15T00:00:00Z',
      actorId: 'issuer',
      guildId: null,
      correlationId: 'r',
      payload: { [field]: 'opaque' },
    };
    expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
    for (const key of [
      'reason',
      'answer',
      'explanation',
      'sessionHash',
      'ownership',
      'assessedRank',
    ])
      expect(
        EventEnvelopeSchema.safeParse({ ...event, payload: { ...event.payload, [key]: 'private' } })
          .success,
      ).toBe(false);
  },
);
it('rejects forged actor/options/resources/technical text before queries', async () => {
  let calls = 0;
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      calls++;
      return [];
    },
  };
  for (const field of ['role', 'participantId', 'canReview'])
    await expect(
      issuePracticeReviewAssignment(
        tx,
        { ...command, actor: { ...actor, [field]: 'forged' } } as PracticeReviewAssignmentCommand,
        options,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  for (const canManage of [undefined, null, true])
    await expect(
      issuePracticeReviewAssignment(tx, command, {
        ...options,
        canManage,
      } as unknown as PracticeReviewAssignmentOptions),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  for (const reason of ['😀'.repeat(1001), 'a\0b', 'a\ud800b'])
    await expect(
      issuePracticeReviewAssignment(
        tx,
        { ...command, input: { ...command.input, reason } },
        options,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    revokePracticeReviewAssignment(
      tx,
      { ...command, input: { version: 'v1', assignmentId: 'bad', reason: 'why' } },
      options,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    lockPracticeReviewAssignment(
      tx,
      actor,
      { assignmentId: 'bad', submissionId: randomUUID(), purpose: 'OWNERSHIP_REVIEW' },
      () => true,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    lockPracticeReviewAssignment(
      tx,
      actor,
      { assignmentId: randomUUID(), submissionId: randomUUID(), purpose: 'OWNERSHIP_REVIEW' },
      null as unknown as () => boolean,
    ),
  ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  expect(calls).toBe(0);
});
it('rejects wrong SQL dialect or isolation rather than trusting a host declaration', async () => {
  for (const patch of [{ dialect: 'SQLITE' }, { isolation: 'SERIALIZABLE' }])
    await expect(
      issuePracticeReviewAssignment(
        { ...patch, query: async () => [] } as unknown as CommandReceiptTransaction,
        command,
        options,
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
});
