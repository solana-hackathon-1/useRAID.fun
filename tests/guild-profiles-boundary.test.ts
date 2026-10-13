import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('documents the trusted host and provides an independent projection/permission consumer', async () => {
  const doc = await readFile('docs/raid-guild-profiles.md', 'utf8');
  for (const term of [
    'R15',
    'R16',
    'informational',
    'millisecond',
    'NOT VERIFIED',
    'publicProfileApproved',
    'DELEGATE_PROFILE',
    'No storage',
  ])
    expect(doc).toContain(term);
  const example = await readFile('examples/guild-profiles/host.ts', 'utf8');
  expect(example).toContain('projectPublicGuildProfile');
  expect(example).toContain('evaluateGuildProfilePermission');
  expect(example).not.toMatch(/process\.env|from ['"].*lib\//);
});
