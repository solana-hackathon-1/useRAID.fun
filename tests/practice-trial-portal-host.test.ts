import { cp, mkdtemp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('renders in an independent host with explicit dependencies and no dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raid-practice-portal-consumer-'));
  for (const name of ['host.tsx', 'package.json', 'tsconfig.json'])
    await cp('examples/practice-trial-portal/' + name, join(dir, name));
  for (const name of ['contracts', 'skills', 'components'])
    await cp('examples/practice-trial-portal/' + name, join(dir, name), {
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
    catalogRenders: true,
    unavailableHonest: true,
    workspaceForm: true,
    aiProhibitedRefused: true,
    noDispatchDuringSsr: true,
    invalidHostDenied: true,
  });
}, 15000);
