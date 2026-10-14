import { readFile, cp, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('keeps practice contracts pure with explicit owned dependencies', async () => {
  const allowed = new Set([
    'zod',
    '../contracts/ids',
    '../contracts/entities',
    './contracts',
    './practice-trial-contracts',
  ]);
  for (const name of ['practice-trials.ts', 'practice-trial-contracts.ts']) {
    const source = await readFile('src/skills/' + name, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(allowed.has(match[1]), match[1]).toBe(true);
    expect(source).not.toMatch(
      /process\.env|\bfetch\s*\(|\bconsole\.|\brequire\s*\(|\bimport\s*\(/,
    );
  }
});
it('runs a copied console host with explicit CI fixture runtime and alternate approval policies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raid-t013-ci-consumer-'));
  await cp('examples/practice-trials', dir, { recursive: true, dereference: true });
  // CI supplies its installed runtime explicitly; independent npm ci verifies own declared dependencies separately.
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  const out = execFileSync(
    process.execPath,
    [join(dir, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' } },
  );
  expect(JSON.parse(out)).toEqual({
    synthetic: true,
    alternateApprovalPorts: true,
    immutableDefinitionBinding: true,
    canonicalSubjectBinding: true,
    staleHistoryDenied: true,
    approvedAccommodation: true,
    noRankOrCapacityOrFinancialEffect: true,
  });
}, 15000);
