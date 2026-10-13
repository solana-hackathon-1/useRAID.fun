import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('keeps proposal proof composition independent of application, storage, provider and secret state', async () => {
  const allowed = new Set([
    'zod',
    '../contracts/assets',
    './control-attestation',
    './control-attestation-contracts',
    './proposal-control-contracts',
    './project-proposal-contracts',
  ]);
  for (const file of ['proposal-control.ts', 'proposal-control-contracts.ts']) {
    const source = await readFile('src/guild-profiles/' + file, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(allowed.has(match[1]), match[1]).toBe(true);
    expect(source).not.toMatch(
      /process\.env|\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(|\bconsole\./,
    );
  }
});
