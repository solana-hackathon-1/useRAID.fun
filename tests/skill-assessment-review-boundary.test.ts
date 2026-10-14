import { readFile, cp, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('has pure owned imports with no app/provider/global authority or execution', async () => {
  const allowed = new Set([
    'zod',
    '../contracts/ids',
    '../contracts/entities',
    './contracts',
    './practice-trial-contracts',
    './assessment-review-contracts',
  ]);
  for (const name of ['assessment-review.ts', 'assessment-review-contracts.ts']) {
    const source = await readFile('src/skills/' + name, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(allowed.has(match[1]), match[1]).toBe(true);
    expect(source).not.toMatch(
      /process\.env|\bfetch\s*\(|\bconsole\.|\brequire\s*\(|\bimport\s*\(/,
    );
  }
});
it('runs a copied console host using explicit CI runtime and both approval ports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raid-t013-assessment-ci-consumer-'));
  await cp('examples/skill-assessments', dir, { recursive: true, dereference: true });
  // Separate own-install evidence verifies declared dependencies; CI fixture explicitly supplies its runtime.
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  const out = execFileSync(
    process.execPath,
    [join(dir, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' } },
  );
  expect(JSON.parse(out)).toEqual({
    synthetic: true,
    alternateApprovalPorts: true,
    scopedEvaluator: true,
    selfReviewDenied: true,
    immutableVersions: true,
    staleFactsDenied: true,
    reasonedReassessment: true,
    noCommittedRankOrCapacityOrMoney: true,
  });
}, 15000);
