import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('keeps taxonomy and claim preparation independent of app authority, persistence, providers and wealth', async () => {
  const allowed = new Set(['zod', '../contracts/ids', '../contracts/entities', './contracts']);
  for (const file of ['index.ts', 'contracts.ts']) {
    const source = await readFile('src/skills/' + file, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(allowed.has(match[1]), match[1]).toBe(true);
    expect(source).not.toMatch(
      /process\.env|\bfetch\s*\(|\brequire\s*\(|\bimport\s*\(|\bconsole\./,
    );
  }
});
