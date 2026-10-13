import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('documents replaceable authenticated private HTTP contracts and provides an independently installed consumer', async () => {
  const doc = await readFile('docs/raid-guild-draft-http.md', 'utf8');
  for (const text of [
    'R15',
    'R16',
    'GuildDraftHttpHost',
    'GUILD_DRAFTS_ENABLED',
    'NOT VERIFIED',
    '5000',
    '16384',
    'DRAFT_SLUG_UNAVAILABLE',
    'Cookie',
    'POST /api/v1/guild-drafts',
  ])
    expect(doc).toContain(text);
  const consumer = await readFile('examples/guild-drafts/host.ts', 'utf8');
  expect(consumer).toContain('createGuildDraftHandlers');
  expect(consumer).toContain('new Request');
  expect(consumer).not.toMatch(/from ['"].*lib\//);
});
