import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('consumes only the public identity interface outside the RAID app with explicit dependencies', async () => {
  for (const name of await readdir('src/identity')) {
    const source = await readFile(join('src/identity', name), 'utf8');
    expect(source).not.toMatch(/process\.env|globalThis|@\/|@prisma|next\/|from ['"].*lib\//);
  }
  const directory = await mkdtemp(join(tmpdir(), 'raid-t006-preflight-consumer-'));
  try {
    await cp('src/identity', join(directory, 'src/identity'), { recursive: true });
    await cp('src/contracts', join(directory, 'src/contracts'), { recursive: true });
    await cp('examples/identity-preflight/host.ts', join(directory, 'host.ts'));
    await cp('examples/identity-preflight/package.json', join(directory, 'package.json'));
    // Explicit existing fixture runtime; separately installed host evidence is recorded in the task.
    await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
    const output = execFileSync(process.execPath, [join(directory, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'], {
      cwd: directory, encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    });
    expect(JSON.parse(output)).toEqual({
      version: 'v1', simulation: true, executionEnabled: false,
      sameParticipant: true, capacityRetained: true, subjectSupplierReplacementStable: true,
      collisionBlocked: true, replayBlocked: true, removalBlocked: true,
      unknownInventoryBlocked: true, revokedLinkBlocked: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
