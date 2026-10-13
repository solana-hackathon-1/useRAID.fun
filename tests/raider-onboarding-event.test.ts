import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
it('supports the identifier-only private onboarding audit without copying preferences', () => {
  const event = {
    eventId: 'event-1',
    type: 'identity.onboarding_recorded.v1',
    aggregateId: 'account-1',
    aggregateVersion: 1,
    occurredAt: '2026-10-13T00:00:00.000Z',
    actorId: 'account-1',
    guildId: null,
    correlationId: 'request-1',
    payload: { orientationVersionId: 'version-1' },
  };
  expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
  expect(
    EventEnvelopeSchema.safeParse({
      ...event,
      payload: { ...event.payload, timezone: 'Asia/Kathmandu' },
    }).success,
  ).toBe(false);
});
