import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
it('accepts only an opaque private ownership version audit reference', () => {
  const event = {
    eventId: 'e',
    type: 'skill.practice_trial_ownership_recorded.v1',
    aggregateId: 'policy',
    aggregateVersion: 1,
    occurredAt: '2026-10-15T00:00:00Z',
    actorId: 'admin',
    guildId: null,
    correlationId: 'r',
    payload: { practiceTrialOwnershipVersionId: 'version' },
  };
  expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
  for (const field of [
    'reason',
    'observations',
    'answer',
    'ownership',
    'assessedRank',
    'sessionHash',
  ])
    expect(
      EventEnvelopeSchema.safeParse({ ...event, payload: { ...event.payload, [field]: 'private' } })
        .success,
    ).toBe(false);
});
