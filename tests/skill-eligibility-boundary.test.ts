import { readFile, cp, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('has only declared pure owned dependencies and no app, provider, wealth or access inputs', async () => {
  const allowed = new Set([
    'zod',
    '../contracts/ids',
    '../contracts/entities',
    './contracts',
    './eligibility-contracts',
  ]);
  for (const name of ['eligibility.ts', 'eligibility-contracts.ts']) {
    const source = await readFile('src/skills/' + name, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
      expect(allowed.has(match[1]), match[1]).toBe(true);
    expect(source).not.toMatch(
      /process\.env|\bfetch\s*\(|\bconsole\.|\brequire\s*\(|\bimport\s*\(/,
    );
  }
});
it('runs a copied console host outside the app with explicit test runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raid-t014-ci-consumer-'));
  await cp('src/contracts', join(dir, 'contracts'), { recursive: true });
  await cp('examples/skill-eligibility/host.ts', join(dir, 'host.ts'));
  await cp('examples/skill-eligibility/package.json', join(dir, 'package.json'));
  await cp('examples/skill-eligibility/skills', join(dir, 'skills'), {
    recursive: true,
    dereference: true,
  });
  // CI fixture explicitly supplies root runtime; a separate own-install host verifies declared dependencies.
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  await writeFile(
    join(dir, 'source.json'),
    JSON.stringify({ synthetic: true, runtime: 'explicit-root-fixture', source: process.cwd() }),
  );
  const out = execFileSync(
    process.execPath,
    [join(dir, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' } },
  );
  expect(JSON.parse(out)).toEqual({
    synthetic: true,
    explicitPartyCoverage: true,
    wrongDomainRejected: true,
    staleIsUnknown: true,
    noPurchasedRank: true,
    noPermissionOrCapacityEffect: true,
    privateEvidenceOmitted: true,
  });
  // No server/process remains; retain copied source as evidence rather than removing it.
}, 15000);
