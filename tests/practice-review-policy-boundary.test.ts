import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
it('accepts only an opaque private review-policy version audit reference', () => {
  const event = {
    eventId: 'e',
    type: 'skill.practice_review_policy_published.v1',
    aggregateId: 'policy',
    aggregateVersion: 1,
    occurredAt: '2026-10-15T00:00:00Z',
    actorId: 'admin',
    guildId: null,
    correlationId: 'r',
    payload: { practiceReviewPolicyVersionId: 'version' },
  };
  expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
  for (const field of ['guidance', 'answer', 'approved', 'assessedRank', 'sessionHash'])
    expect(
      EventEnvelopeSchema.safeParse({ ...event, payload: { ...event.payload, [field]: 'private' } })
        .success,
    ).toBe(false);
});
