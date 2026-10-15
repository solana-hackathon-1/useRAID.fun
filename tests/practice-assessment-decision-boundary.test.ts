import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
it('permits only opaque assessment decision audit provenance without private case facts', () => {
  const e = {
    eventId: 'e',
    type: 'skill.assessment_revoked.v1',
    aggregateId: 'a',
    aggregateVersion: 2,
    occurredAt: '2026-10-15T00:00:00Z',
    actorId: 'reviewer',
    guildId: null,
    correlationId: 'r',
    payload: { practiceAssessmentDecisionId: 'decision' },
  };
  expect(EventEnvelopeSchema.safeParse(e).success).toBe(true);
  for (const k of ['reason', 'findings', 'assessedRank', 'answer', 'sessionHash', 'reasonCategory'])
    expect(
      EventEnvelopeSchema.safeParse({ ...e, payload: { ...e.payload, [k]: 'private' } }).success,
    ).toBe(false);
});
