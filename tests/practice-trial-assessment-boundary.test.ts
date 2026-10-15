import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
it.each(['practiceAssessmentReviewVersionId', 'skillAssessmentVersionId'])(
  'accepts only opaque private assessment audit key %s',
  (field) => {
    const event = {
      eventId: 'e',
      type: 'skill.assessment_issued.v1',
      aggregateId: 'assessment',
      aggregateVersion: 1,
      occurredAt: '2026-10-15T00:00:00Z',
      actorId: 'evaluator',
      guildId: null,
      correlationId: 'r',
      payload: { [field]: 'version' },
    };
    expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
    for (const key of [
      'reason',
      'criteria',
      'confidenceStatement',
      'assessedRank',
      'answer',
      'guidance',
      'approved',
      'sampleSize',
      'sessionHash',
    ])
      expect(
        EventEnvelopeSchema.safeParse({ ...event, payload: { ...event.payload, [key]: 'private' } })
          .success,
      ).toBe(false);
  },
);
