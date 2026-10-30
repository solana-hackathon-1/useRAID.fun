import { cp, mkdtemp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('renders in an independent host with explicit dependencies and no dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raid-work-workspace-consumer-'));
  for (const name of ['host.tsx', 'package.json', 'tsconfig.json'])
    await cp('examples/work-workspace/' + name, join(dir, name));
  for (const name of [
    'contracts',
    'command-receipts',
    'asset-registry',
    'identity-locks',
    'work-loop',
    'components',
    'work-http',
  ])
    await cp('examples/work-workspace/' + name, join(dir, name), {
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
    workspaceRenders: true,
    unavailableHonest: true,
    deskRenders: true,
    noDispatchDuringSsr: true,
    conflictRefreshes: true,
    unreachableRetriesSameRequest: true,
    amendmentConsentRenders: true,
    amendmentStaleRefreshes: true,
  });
}, 20000);
