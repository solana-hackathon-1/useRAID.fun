import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('keeps holder computation independent of database, RPC SDK, roles and public enrollment writes', async () => {
  const allowed = new Set([
    'zod',
    '../contracts/assets',
    '../contracts/ids',
    '../contracts/entities',
    './holder-observation-contracts',
  ]);
  for (const file of ['holder-observation.ts', 'holder-observation-contracts.ts']) {
    const source = await readFile('src/guild-profiles/' + file, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(allowed.has(match[1]), match[1]).toBe(true);
    expect(source).not.toMatch(
      /process\.env|\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(|\bconsole\./,
    );
  }
});
