import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('T026 launch route boundary and reuse contract (R15, R16)', () => {
  it('is a framework-free, SDK-free, signer-free module with only sibling-contract imports', async () => {
    const names = (await readdir('src/launch-route')).sort();
    expect(names).toEqual(['errors.ts', 'index.ts', 'meteora-dbc.ts', 'types.ts']);
    for (const name of names) {
      const source = await readFile(join('src/launch-route', name), 'utf8');
      expect(source, name).not.toMatch(
        /process\.env|globalThis|Math\.random|@\/|@prisma|@solana|@meteora|next\/|from ['"].*lib\//,
      );
      expect(source, name).not.toMatch(/secretKey|Keypair|signTransaction|sendTransaction|\.sign\(/);
      expect(source, name).not.toMatch(/api\.mainnet|mainnet-beta\.solana/);
      for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g))
        expect(match[1], name).toMatch(/^\.\/|^\.\.\/(asset-registry|contracts)\/|^node:crypto$/);
    }
  });

  it('adds no dependency and leaves the disabled Pump route untouched', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const all = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all).not.toMatch(/meteora/i);
    const pump = await readFile('src/lib/pump-launch.ts', 'utf8');
    expect(pump).not.toMatch(/launch-route|meteora/i);
  });

  it('runs the declared minimal host outside the application', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raid-t026-consumer-'));
    try {
      await cp('examples/launch-route', directory, { recursive: true, dereference: true });
      await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
      const output = execFileSync(
        process.execPath,
        [join(directory, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 20000,
          env: { PATH: process.env.PATH, NODE_ENV: 'test' },
        },
      );
      expect(JSON.parse(output)).toEqual({
        notConfiguredByDefault: true,
        mainnetRefused: true,
        pinnedIntent: true,
        liveOnlyWhenFinalizedAndMatching: true,
        graduationNeedsCreatedPool: true,
        substituteRouteSameResults: true,
        sanitizedFailure: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);

  it('documents the R16 contract, the Meteora immutable-metadata finding and open decisions', async () => {
    const doc = await readFile('docs/raid-launch-route.md', 'utf8');
    for (const heading of [
      'Purpose and non-goals',
      'Dependency and host contract',
      'Public interface',
      'Entity and state ownership',
      'Permissions and trust boundary',
      'Configuration names',
      'Errors and idempotency',
      'Substitution and versioning',
      'Observability',
      'Failure and recovery runbook',
      'Limitations',
      'Run the standalone consuming host',
    ])
      expect(doc).toContain(`## ${heading}`);
    for (const term of [
      'DEC-2026-11-07-04',
      'O01',
      'O02',
      'O08',
      'R15',
      'R16',
      'NOT_CONFIGURED',
      'NETWORK_REFUSED',
      'PROTOCOL_MISMATCH',
      'https://docs.meteora.ag/developer-guides/dbc/program/accounts',
      'NOT VERIFIED',
      'Pump',
    ])
      expect(doc).toContain(term);
    const reuse = await readFile('docs/raid-module-reuse.md', 'utf8');
    expect(reuse).toContain('raid-launch-route.md');
    expect(await readFile('examples/launch-route/README.md', 'utf8')).toContain(
      '../../docs/raid-launch-route.md',
    );
  });
});
