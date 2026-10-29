import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('documents the authority model and keeps the module free of application dependencies', async () => {
  const doc = await readFile('docs/raid-guild-storage.md', 'utf8');
  for (const term of [
    'R15',
    'R16',
    'AC07',
    'activateGuild',
    'hasGuildAuthority',
    'TREASURY',
    'DISPUTE',
    'NOT VERIFIED',
    'authorizeActivation',
    'cross-Guild',
  ])
    expect(doc.toLowerCase()).toContain(term.toLowerCase());
  for (const file of ['guild-storage.ts', 'guild-storage-contracts.ts']) {
    const source = await readFile(`src/guild-profiles/${file}`, 'utf8');
    expect(source, file).not.toMatch(/process\.env|@prisma|from ['"]next|from ['"]\.\.\/lib\//);
  }
  const example = await readFile('examples/guild-storage/host.ts', 'utf8');
  for (const call of ['activateGuild', 'editGuildProfile', 'readPublicGuild', 'hasGuildAuthority'])
    expect(example).toContain(call);
  expect(example).not.toMatch(/process\.env|from ['"].*lib\//);
  expect((await readdir('examples/guild-storage')).sort()).toEqual(
    expect.arrayContaining(['README.md', 'host.ts', 'migrate.ts', 'migrations', 'package.json']),
  );
});
