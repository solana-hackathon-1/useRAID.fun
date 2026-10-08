import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('T029 public module boundary and reuse contract (R15, R16, AC74)', () => {
  it('owns arithmetic and registry rules without an app singleton, framework, SDK or float', async () => {
    const names = await readdir('src/asset-registry');
    expect(names.sort()).toEqual([
      'amounts.ts',
      'bundle.ts',
      'errors.ts',
      'index.ts',
      'production.ts',
      'registry.ts',
    ]);
    for (const name of names) {
      const source = await readFile(join('src/asset-registry', name), 'utf8');
      expect(source, name).not.toMatch(
        /process\.env|globalThis|Date\.now|new Date|Math\.random|@\/|@prisma|@solana|next\/|from ['"].*lib\//,
      );
      // No floating point in exact arithmetic: no Number() coercion of amounts and no parseFloat.
      expect(source, name).not.toMatch(/parseFloat|Number\(\s*(amount|value|total|weight)/);
      for (const match of source.matchAll(/from ['"](\.[^'"]+)['"]/g))
        expect(match[1], name).toMatch(/^\.\/|^\.\.\/contracts\//);
    }
  });

  it('reuses the shared T002 asset contracts instead of redefining them', async () => {
    const combined = (
      await Promise.all(
        (await readdir('src/asset-registry')).map((name) =>
          readFile(join('src/asset-registry', name), 'utf8'),
        ),
      )
    ).join('\n');
    for (const name of ['AssetIdSchema', 'AssetPolicySnapshotSchema', 'assetKey', 'AmountSchema'])
      expect(combined).toContain(name);
    expect(combined).not.toMatch(
      /export (const|function) (assetKey|parseDisplayAmount|formatDisplayAmount)\b/,
    );
    expect(combined).not.toMatch(/z\.strictObject|z\.object/);
  });

  it('ships no supported production asset and no production-looking constants', async () => {
    const production = await readFile('src/asset-registry/production.ts', 'utf8');
    expect(production).toContain('PRODUCTION_ASSET_ALLOWLIST');
    expect(production).toMatch(/PRODUCTION_ASSET_ALLOWLIST[^=]*=\s*Object\.freeze\(\[\]\)/);
    const registry = await readFile('src/asset-registry/registry.ts', 'utf8');
    // Only the two Solana token program IDs are named; no mint, genesis hash or ticker allow list.
    expect(registry.match(/'[1-9A-HJ-NP-Za-km-z]{32,44}'/g)).toEqual([
      "'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'",
      "'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'",
    ]);
  });

  it('adds only the additive asset migration under the reserved name', async () => {
    const names = (await readdir('prisma/migrations')).filter((name) =>
      name.includes('asset_registry'),
    );
    expect(names).toEqual(['202610090002_asset_registry']);
    const sql = await readFile(
      'prisma/migrations/202610090002_asset_registry/migration.sql',
      'utf8',
    );
    expect(sql).not.toMatch(/DROP |ALTER TABLE|UPDATE "(?!Asset)|INSERT INTO|DELETE FROM/);
    expect(sql).toContain('CREATE TABLE "Asset"');
    expect(sql).toContain('CREATE TABLE "AssetPolicySnapshot"');
  });

  it('runs the declared minimal host outside the application with explicit dependencies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'raid-t029-consumer-'));
    try {
      await cp('examples/asset-registry', directory, { recursive: true, dereference: true });
      // Explicit existing fixture runtime; independent installation is separate recorded evidence.
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
      const result = JSON.parse(output);
      expect(result).toEqual({
        version: 'v1',
        synthetic: true,
        sameTickerSeparate: true,
        wrongNetworkRejected: true,
        policyVersionNoSplit: true,
        decimalsChangeRefused: true,
        partialRewardNotFunded: true,
        completeRewardFunded: true,
        excessPrecisionRefused: true,
        exactAmounts: true,
        emptyProductionAllowlist: true,
        productionBlocked: true,
        alternateSourceEquivalent: true,
        sanitizedFailure: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);

  it('documents the R16 reuse contract and the open O07/G04 gate', async () => {
    const doc = await readFile('docs/raid-asset-registry.md', 'utf8');
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
      'R15',
      'R16',
      'I03',
      'AC28',
      'AC29',
      'AC30',
      'AC41',
      'O07',
      'G04',
      'PRODUCTION_ASSET_ALLOWLIST',
      'createAssetRegistry',
      'evaluateRewardFunding',
      'splitProportional',
      'parseAmount',
      'U64_MAX',
      '202610090002_asset_registry',
      'NOT VERIFIED',
    ])
      expect(doc).toContain(term);
    expect(doc).not.toMatch(/postgres(?:ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/);
    const readme = await readFile('examples/asset-registry/README.md', 'utf8');
    expect(readme).toContain('../../docs/raid-asset-registry.md');
  });
});
