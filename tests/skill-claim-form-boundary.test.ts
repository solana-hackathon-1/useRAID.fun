import { readFile, cp, mkdtemp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('declares a portable claim transport and imports only React and owned contracts', async () => {
  const source = await readFile('src/components/skill-claim-form.tsx', 'utf8');
  const allowed = new Set([
    'react',
    'zod',
    '../contracts/ids',
    '../skills/contracts',
    '../skills/http-contracts',
  ]);
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))
    expect(allowed.has(match[1]), match[1]).toBe(true);
  expect(source).not.toMatch(
    /@\/|process\.env|localStorage|sessionStorage|\bconsole\.|\brequire\s*\(|\bimport\s*\(/,
  );
});
it('renders enabled/disabled independent host without hidden app or dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raid-t012-form-ci-consumer-'));
  for (const name of ['host.tsx', 'package.json', 'tsconfig.json'])
    await cp('examples/skill-claim-form/' + name, join(dir, name));
  for (const name of ['contracts', 'skills', 'components'])
    await cp('examples/skill-claim-form/' + name, join(dir, name), {
      recursive: true,
      dereference: true,
    });
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  const output = execFileSync(
    process.execPath,
    [join(dir, 'node_modules/tsx/dist/cli.mjs'), 'host.tsx'],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' } },
  );
  expect(JSON.parse(output)).toEqual({
    synthetic: true,
    portableReact: true,
    enabledAndDisabled: true,
    noHiddenAppOrNetwork: true,
    unverifiedLabels: true,
    invalidHostDenied: true,
  });
  // Explicit CI fixture runtime only. Own-install check independently proves package/lock declarations; retain source.
}, 15000);
