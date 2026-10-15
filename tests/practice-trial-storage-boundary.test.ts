import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
import {
  publishPracticeTrialDefinition,
  readPracticeTrialDefinition,
} from '../src/skills/practice-trial-storage';
import { type CommandReceiptTransaction } from '../src/command-receipts';
import { definition } from '../examples/skill-assessments/fixtures';
it('accepts only identifier references in private practice publication audit', () => {
  const event = {
    eventId: 'e',
    type: 'skill.practice_trial_published.v1',
    aggregateId: 'trial',
    aggregateVersion: 1,
    occurredAt: '2026-10-15T00:00:00Z',
    actorId: 'admin',
    guildId: null,
    correlationId: 'r',
    payload: { practiceTrialVersionId: 'version' },
  };
  expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
  for (const key of ['definition', 'criteria', 'assessedRank', 'answers'])
    expect(
      EventEnvelopeSchema.safeParse({ ...event, payload: { ...event.payload, [key]: 'private' } })
        .success,
    ).toBe(false);
});
it('rejects forged actor/options/body and unsupported PostgreSQL strings before any query', async () => {
  let calls = 0;
  const tx: CommandReceiptTransaction = {
    dialect: 'POSTGRESQL',
    isolation: 'READ_COMMITTED',
    async query() {
      calls++;
      return [];
    },
  };
  const draft = structuredClone(definition);
  for (const key of ['reference', 'state', 'publishedAt']) Reflect.deleteProperty(draft, key);
  const command = {
      actor: { accountId: 'admin', sessionHash: 'a'.repeat(64) },
      input: {
        trialId: 'trial',
        expectedRevision: 0,
        taxonomyReference: { recordId: 'catalog', revision: 1 },
        availability: 'AVAILABLE',
        draft,
      },
      idempotencyKey: 'k',
      requestId: 'r',
    },
    options = { allowNewWrites: true, canPublish: () => true };
  for (const field of ['role', 'xId', 'isAdmin'])
    await expect(
      publishPracticeTrialDefinition(
        tx,
        { ...command, actor: { ...command.actor, [field]: 'forged' } },
        options,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    publishPracticeTrialDefinition(
      tx,
      { ...command, input: { ...command.input, publishedAt: 'forged' } },
      options,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const malformedOptions = { ...options };
  Reflect.set(malformedOptions, 'allowNewWrites', undefined);
  await expect(publishPracticeTrialDefinition(tx, command, malformedOptions)).rejects.toMatchObject(
    { code: 'STORAGE_CONTRACT' },
  );
  await expect(
    readPracticeTrialDefinition(tx, command.actor, 'bad identifier'),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  for (const text of ['bad\u0000data', 'bad\ud800data'])
    await expect(
      publishPracticeTrialDefinition(
        tx,
        { ...command, input: { ...command.input, draft: { ...draft, brief: text } } },
        options,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(calls).toBe(0);
});
