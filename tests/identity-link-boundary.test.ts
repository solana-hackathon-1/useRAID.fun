import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const NEW_TESTS = [
  'tests/identity-link-boundary.test.ts',
  'tests/identity-link-db.test.ts',
  'tests/identity-link-migration.test.ts',
  'tests/identity-link.test.ts',
  'tests/wallet-link-proof.test.ts',
];

it('public link module owns SQL and contracts without an app singleton, framework or SDK', async () => {
  for (const name of await readdir('src/identity-link')) {
    const source = await readFile(join('src/identity-link', name), 'utf8');
    expect(source, name).not.toMatch(
      /process\.env|globalThis|@\/|@prisma|next\/|from ['"].*lib\/|Date\.now|new Date\(/,
    );
  }
  const proof = await readFile('src/lib/wallet-link-proof.ts', 'utf8');
  expect(proof).not.toMatch(
    /from ['"].*(?:\/db|config)['"]|process\.env|globalThis|@prisma|next\//,
  );
  const adapter = await readFile('src/lib/identity-storage-adapter.ts', 'utf8');
  expect(adapter).not.toMatch(/from ['"].*(?:\/db|config)['"]|process\.env|globalThis/);
});

it('PR-B1 only adds credential resolution; additional-link commands and enablement stay unavailable (WR13)', async () => {
  const walletAuth = await readFile('src/lib/wallet-auth.ts', 'utf8');
  expect(walletAuth).toContain('lookupWalletLink');
  expect(walletAuth).not.toMatch(/linkVerifiedWallet|linkAdditionalWallet|link-additional/);
  const xOauth = await readFile('src/lib/x-oauth.ts', 'utf8');
  expect(xOauth).not.toMatch(/identity-link|walletLink|WalletLink/);
  const config = await readFile('src/lib/config.ts', 'utf8');
  expect(config).not.toMatch(/wallet_links_enabled|walletLinksEnabled/);
});

it.skipIf(process.env.RUN_DB_TESTS !== 'true')(
  'minimal external host links a second wallet using explicit dependencies',
  async () => {
    assertTestDatabase();
    const directory = await mkdtemp(join(tmpdir(), 'raid-t006-wallet-links-consumer-'));
    const db = new PrismaClient({ log: [] });
    try {
      await truncateAll(db);
      await cp('examples/wallet-links', directory, { recursive: true, dereference: true });
      // Explicit existing fixture runtime; independent installation is separate recorded evidence.
      await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
      const output = execFileSync(
        process.execPath,
        [join(directory, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 20000,
          env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL },
        },
      );
      expect(JSON.parse(output)).toEqual({
        version: 'v1',
        synthetic: true,
        realDatabase: true,
        sameParticipant: true,
        primaryUnchanged: true,
        idempotentReplay: true,
        foreignAddressConflict: true,
        primaryRequired: true,
        wrongActorDenied: true,
        proofDerived: true,
        alternatePort: true,
        sanitizedFailure: true,
      });
    } finally {
      await truncateAll(db);
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

it('module documentation declares the R16 reuse contract and runnable consumer steps', async () => {
  const doc = await readFile('docs/raid-wallet-links.md', 'utf8');
  for (const heading of [
    'Purpose and non-goals',
    'Dependency and host contract',
    'Public interface',
    'Entity and state ownership',
    'Lock order and concurrency contract',
    'Permissions and trust boundary',
    'Configuration names',
    'Transaction, retry and sanitized errors',
    'Legacy readers and writers',
    'Substitution and versioning',
    'Observability',
    'Failure and recovery runbook',
    'Rollout and rollback',
    'Limitations',
    'Run the standalone consuming host',
  ])
    expect(doc).toContain(`## ${heading}`);
  for (const term of [
    'R15',
    'R16',
    'R04',
    'R13',
    'I01',
    'AC01',
    'READ COMMITTED',
    'DATABASE_URL',
    'linkVerifiedWallet',
    'listWalletLinks',
    'IdentityTransaction',
    'PRIMARY_WALLET_REQUIRED',
    'wallet_link_guard_v1',
    'raid_wallet_subject_exclusive_v1',
    'wallet-subject:',
    'FOR NO KEY UPDATE',
    'prisma migrate deploy',
    'PARTIAL',
    'NOT VERIFIED',
    'PR-B',
  ])
    expect(doc).toContain(term);
  expect(doc).not.toMatch(/postgres(?:ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/);
  const readme = await readFile('examples/wallet-links/README.md', 'utf8');
  expect(readme).toContain('../../docs/raid-wallet-links.md');
  const storage = await readFile('docs/raid-identity-storage.md', 'utf8');
  expect(storage).toContain('raid-wallet-links.md');
});

it('new test files are registered in the CI matrix and the evidence records WR01-WR14', async () => {
  const matrix = JSON.parse(await readFile('planning/raid-ci-matrix.json', 'utf8'));
  for (const file of NEW_TESTS) {
    expect(matrix.test_files).toContain(file);
    expect(JSON.stringify(matrix.epics ?? matrix)).toContain(file);
  }
  const evidence = JSON.parse(
    await readFile('planning/task-evidence/T006-wallet-links-wip.json', 'utf8'),
  );
  expect(Object.keys(evidence.condition_dispositions).sort()).toEqual(
    Array.from({ length: 14 }, (_, i) => `WR${String(i + 1).padStart(2, '0')}`).sort(),
  );
  for (const entry of Object.values(evidence.condition_dispositions) as {
    disposition: string;
    evidence: string;
  }[]) {
    expect(entry.disposition).toMatch(/^(SATISFIED|PARTIAL|DEFERRED)/);
    expect(entry.evidence.length).toBeGreaterThan(10);
  }
  expect(evidence.status).toContain('NOT VERIFIED');
  expect(evidence.criteria_status).toMatch(/NOT VERIFIED/);
  expect(evidence.ac01).toMatch(/PARTIAL/);
});
