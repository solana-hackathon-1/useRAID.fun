import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { EventEnvelopeSchema } from '../src/contracts/protocol';
it('declares private owner storage, real transaction/session dependencies and an independently installed host', async () => {
  const doc = await readFile('docs/raid-guild-drafts.md', 'utf8');
  for (const text of [
    'R15',
    'R16',
    'READ COMMITTED',
    'clock_timestamp',
    'GuildDraftActor',
    'SaveGuildDraft',
    'NOT VERIFIED',
    'DRAFT_UNVERIFIED',
    'guildDraftVersionId',
    'SLUG_UNAVAILABLE',
  ])
    expect(doc).toContain(text);
  const consumer = await readFile('examples/guild-drafts/host.ts', 'utf8');
  expect(consumer).toContain('saveGuildDraft');
  expect(consumer).toContain('readGuildDraft');
  expect(consumer).not.toMatch(/from ['"].*lib\//);
});
it('supports a private identifier-only draft audit, excluding text and privilege fields', () => {
  const event = {
    eventId: 'event-1',
    type: 'guild.draft_recorded.v1',
    aggregateId: 'draft-1',
    aggregateVersion: 1,
    occurredAt: '2026-10-13T00:00:00.000Z',
    actorId: 'owner-1',
    guildId: null,
    correlationId: 'request-1',
    payload: { guildDraftVersionId: 'version-1' },
  };
  expect(EventEnvelopeSchema.safeParse(event).success).toBe(true);
  expect(
    EventEnvelopeSchema.safeParse({
      ...event,
      payload: { ...event.payload, description: 'private' },
    }).success,
  ).toBe(false);
});
