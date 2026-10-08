import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';

it('T004 runs its declared consuming host outside RAID without app configuration or credentials', async () => {
  for (const name of await readdir('tests/fixtures/raid')) {
    const body = await readFile(join('tests/fixtures/raid', name), 'utf8');
    expect(body).not.toMatch(/process\.env|globalThis|@\/|src\/lib|node:|fetch\(/);
  }
  const host = await mkdtemp(join(tmpdir(), 'raid-t004-host-'));
  try {
    await cp('tests/fixtures/raid', join(host, 'fixtures'), { recursive: true });
    await cp('src/contracts', join(host, 'contracts'), { recursive: true });
    await cp('planning/raid-scenarios.json', join(host, 'raid-scenarios.json'));
    await cp('examples/raid-fixtures/host.ts', join(host, 'host.ts'));
    await cp('examples/raid-fixtures/package.json', join(host, 'package.json'));
    await symlink(join(process.cwd(), 'node_modules'), join(host, 'node_modules'), 'dir');
    await writeFile(
      join(host, 'tsconfig.json'),
      '{"compilerOptions":{"module":"esnext","target":"es2022","strict":true}}',
    );
    const output = execFileSync(
      process.execPath,
      [join(host, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
      {
        cwd: host,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, NODE_ENV: 'test' },
        timeout: 15000,
      },
    );
    expect(JSON.parse(output)).toEqual({
      simulation: true,
      scenariosPlanned: 75,
      scenariosVerified: 0,
      distinctSameSymbolAssets: true,
      fixtureAssurance: 'FIXTURE_STRUCTURE',
      unexecutedPassRejected: true,
    });
  } finally {
    await rm(host, { recursive: true, force: true });
  }
});
