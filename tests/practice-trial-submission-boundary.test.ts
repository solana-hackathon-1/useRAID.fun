import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
it('accepts only an opaque private submission audit reference', () => {
  const event = {
    eventId: 'e',
    type: 'skill.practice_trial_submitted.v1',
    aggregateId: 'submission',
    aggregateVersion: 1,
    occurredAt: '2026-10-15T00:00:00Z',
    actorId: 'actor',
    guildId: null,
    correlationId: 'r',
    payload: { practiceTrialSubmissionId: 'submission' },
  };
  expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
  for (const field of ['answer', 'explanation', 'ownership', 'assessedRank'])
    expect(
      EventEnvelopeSchema.safeParse({ ...event, payload: { ...event.payload, [field]: 'private' } })
        .success,
    ).toBe(false);
});
import { randomUUID } from 'node:crypto';
import { SubmitPracticeTrialInputSchema } from '../src/skills/practice-trial-submission-storage';
const body = {
  version: 'v1',
  startId: randomUUID(),
  expectedDefinitionReference: { recordId: 'trial', revision: 1 },
  expectedRubricReference: { recordId: 'rubric', revision: 1 },
  answer: 'Synthetic response.',
  explanation: 'Synthetic explanation.',
  toolsUsed: ['editor'],
  aiAssistanceUsed: false,
  assistanceDisclosure: 'None declared.',
};
it.each([
  ['answer', { answer: '😀'.repeat(20001) }],
  ['explanation', { explanation: '😀'.repeat(2001) }],
  ['assistanceDisclosure', { assistanceDisclosure: '😀'.repeat(2001) }],
  ['toolsUsed', { toolsUsed: ['😀'.repeat(101)] }],
])('bounds %s using the declared UTF16 storage units', (_name, patch) => {
  expect(SubmitPracticeTrialInputSchema.safeParse({ ...body, ...patch }).success).toBe(false);
});
import type { CommandReceiptTransaction } from '../src/command-receipts';
import {
  submitPracticeTrial,
  readPracticeTrialSubmission,
} from '../src/skills/practice-trial-submission-storage';
it('rejects forged actor/options and malformed resource references before any query', async () => {
  let calls = 0;
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      calls++;
      return [];
    },
  };
  const command = {
    actor: { accountId: 'self', sessionHash: 'a'.repeat(64) },
    input: body,
    idempotencyKey: 'key',
    requestId: 'r',
  };
  for (const field of ['role', 'isAdmin', 'participantId'])
    await expect(
      submitPracticeTrial(
        tx,
        { ...command, actor: { ...command.actor, [field]: 'forged' } },
        { allowNewWrites: true },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const options = { allowNewWrites: true };
  Reflect.set(options, 'allowNewWrites', undefined);
  await expect(submitPracticeTrial(tx, command, options)).rejects.toMatchObject({
    code: 'STORAGE_CONTRACT',
  });
  await expect(
    submitPracticeTrial(
      tx,
      {
        ...command,
        input: {
          ...body,
          expectedDefinitionReference: { recordId: 'trial', revision: 2147483648 },
        },
      },
      { allowNewWrites: true },
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    readPracticeTrialSubmission(tx, command.actor, 'bad identifier'),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(calls).toBe(0);
});
