import { expect, it } from 'vitest';
import type { CommandReceiptTransaction } from '../src/command-receipts';
import {
  startPracticeTrial,
  readPracticeTrialStart,
} from '../src/skills/practice-trial-attempt-storage';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
it('permits only identifier references for a private start event', () => {
  const event = {
    eventId: 'e',
    type: 'skill.practice_trial_started.v1',
    aggregateId: 'trial',
    aggregateVersion: 1,
    occurredAt: '2026-10-15T00:00:00Z',
    actorId: 'actor',
    guildId: null,
    correlationId: 'r',
    payload: { practiceTrialStartId: 'start' },
  };
  expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
  for (const field of ['answers', 'submission', 'definition', 'assessedRank'])
    expect(
      EventEnvelopeSchema.safeParse({ ...event, payload: { ...event.payload, [field]: 'private' } })
        .success,
    ).toBe(false);
});

it('rejects invalid actor/options/reference/body before any storage query', async () => {
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
    input: {
      version: 'v1',
      definitionReference: { recordId: 'trial', revision: 1 },
      accommodationReference: null,
    },
    idempotencyKey: 'key',
    requestId: 'r',
  };
  for (const field of ['participantId', 'isAdmin', 'role'])
    await expect(
      startPracticeTrial(
        tx,
        { ...command, actor: { ...command.actor, [field]: 'forged' } },
        { allowNewWrites: true },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const options = { allowNewWrites: true };
  Reflect.set(options, 'allowNewWrites', undefined);
  await expect(startPracticeTrial(tx, command, options)).rejects.toMatchObject({
    code: 'STORAGE_CONTRACT',
  });
  await expect(
    startPracticeTrial(
      tx,
      {
        ...command,
        input: {
          ...command.input,
          definitionReference: { recordId: 'trial', revision: 2147483648 },
        },
      },
      { allowNewWrites: true },
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    startPracticeTrial(
      tx,
      { ...command, input: { ...command.input, participantId: 'forged' } },
      { allowNewWrites: true },
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(readPracticeTrialStart(tx, command.actor, 'not-a-uuid')).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(calls).toBe(0);
});
