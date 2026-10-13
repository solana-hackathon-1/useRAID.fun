import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('documents owner-only bounded pagination and a consuming host without claiming pending-key recovery', async () => {
  const doc = await readFile('docs/raid-guild-draft-list.md', 'utf8');
  for (const text of [
    'R15',
    'R16',
    'listGuildDrafts',
    'pageSize',
    'nextCursor',
    '20',
    'NOT VERIFIED',
    'creation',
    'current session',
    'unknown',
  ])
    expect(doc).toContain(text);
  const host = await readFile('examples/guild-drafts/host.ts', 'utf8');
  expect(host).toContain('listGuildDrafts');
  expect(host).toContain('nextCursor');
  expect(host).not.toMatch(/from ['"].*lib\//);
});
