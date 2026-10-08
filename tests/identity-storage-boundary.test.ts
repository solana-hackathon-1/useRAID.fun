import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

it('public storage owns SQL/contracts without an app singleton, framework or SDK', async () => {
  for (const name of await readdir('src/identity-storage')) {
    const source = await readFile(join('src/identity-storage', name), 'utf8');
    expect(source).not.toMatch(/process\.env|globalThis|@\/|@prisma|next\/|from ['"].*lib\//);
  }
  const adapter = await readFile('src/lib/identity-storage-adapter.ts', 'utf8');
  expect(adapter).not.toMatch(/from ['"].*(?:\/db|config)['"]|process\.env|globalThis/);
});

it.skipIf(process.env.RUN_DB_TESTS !== 'true')(
  'minimal external host resolves a real mapping using explicit dependencies',
  async () => {
    assertTestDatabase();
    const directory = await mkdtemp(join(tmpdir(), 'raid-t006-storage-consumer-'));
    const db = new PrismaClient({ log: [] });
    try {
      await truncateAll(db);
      await cp('examples/identity-storage', directory, { recursive: true, dereference: true });
      // Explicit existing fixture runtime; independent installation is separate recorded evidence.
      await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
      const output = execFileSync(
        process.execPath,
        [join(directory, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 15000,
          env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL },
        },
      );
      expect(JSON.parse(output)).toEqual({
        version: 'v1',
        synthetic: true,
        realDatabase: true,
        stableIdentity: true,
        alternatePort: true,
        wrongActorDenied: true,
        sanitizedFailure: true,
      });
    } finally {
      await truncateAll(db);
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);

it('module documentation declares the R16 reuse contract and runnable consumer steps', async () => {
  const doc = await readFile('docs/raid-identity-storage.md', 'utf8');
  for (const heading of [
    'Purpose and non-goals',
    'Dependency and host contract',
    'Public interface',
    'Entity and state ownership',
    'Permissions and trust boundary',
    'Configuration names',
    'Transaction, retry and sanitized errors',
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
    'I01',
    'READ COMMITTED',
    'DATABASE_URL',
    'findHumanParticipant',
    'ensureHumanParticipant',
    'hasHumanParticipant',
    'IdentityTransaction',
    'participant_mapping_guard_v1',
    'prisma migrate deploy',
    'provisionActorAccountId',
    'NOT VERIFIED',
  ])
    expect(doc).toContain(term);
  expect(doc).not.toMatch(/postgres(?:ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/);
  const readme = await readFile('examples/identity-storage/README.md', 'utf8');
  expect(readme).toContain('../../docs/raid-identity-storage.md');
});
