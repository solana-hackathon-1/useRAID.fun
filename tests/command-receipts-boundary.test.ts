import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

it('public module owns SQL and contracts without an app singleton, framework or SDK', async () => {
  for (const name of await readdir('src/command-receipts')) {
    const source = await readFile(join('src/command-receipts', name), 'utf8');
    expect(source).not.toMatch(/process\.env|globalThis|@\/|@prisma|next\/|from ['"].*lib\//);
    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const specifier of imports)
      expect(specifier.startsWith('.') || specifier === 'node:crypto').toBe(true);
  }
  const adapter = await readFile('src/lib/command-receipts-adapter.ts', 'utf8');
  expect(adapter).not.toMatch(/from ['"].*(?:\/db|config)['"]|process\.env|globalThis/);
});

it('migration is additive, versioned and leaves existing tables untouched', async () => {
  const sql = await readFile(
    'prisma/migrations/202610090001_command_receipts/migration.sql',
    'utf8',
  );
  expect(sql).not.toMatch(/\b(ALTER|DROP)\s+TABLE\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
  expect([...sql.matchAll(/CREATE TABLE "([A-Za-z]+)"/g)].map((m) => m[1]).sort()).toEqual([
    'AuditEvent',
    'CommandReceipt',
    'InboxDelivery',
    'OutboxEvent',
  ]);
});

it.skipIf(process.env.RUN_DB_TESTS !== 'true')(
  'minimal external host runs the documented flow using explicit dependencies',
  async () => {
    assertTestDatabase();
    const directory = await mkdtemp(join(tmpdir(), 'raid-t019-consumer-'));
    const db = new PrismaClient({ log: [] });
    try {
      await truncateAll(db);
      await db.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS "HostCredit" ("id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "claimId" TEXT NOT NULL)',
      );
      await cp('examples/command-receipts', directory, { recursive: true, dereference: true });
      // Explicit existing fixture runtime; independent installation is separate recorded evidence.
      await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
      const output = execFileSync(
        process.execPath,
        [join(directory, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 30000,
          env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL },
        },
      );
      expect(JSON.parse(output)).toEqual({
        version: 'v1',
        synthetic: true,
        realDatabase: true,
        replayedWithoutSecondEffect: true,
        changedPayloadConflict: true,
        duplicateDeliveryOneOutcome: true,
        alternatePort: true,
        capabilityGapFailsClosed: true,
        sanitizedFailure: true,
      });
    } finally {
      await db.$executeRawUnsafe('DROP TABLE IF EXISTS "HostCredit"');
      await truncateAll(db);
      await db.$disconnect();
      await rm(directory, { recursive: true, force: true });
    }
  },
  40000,
);

it('module documentation declares the R16 reuse contract and runnable consumer steps', async () => {
  const doc = await readFile('docs/raid-command-receipts.md', 'utf8');
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
    'I05',
    'I06',
    'AC32',
    'AC69',
    'READ COMMITTED',
    'DATABASE_URL',
    'executeIdempotentCommand',
    'processInboundDelivery',
    'retryWholeTransaction',
    'runCommandTransaction',
    'canonicalRequestDigest',
    'CommandReceiptTransaction',
    'IDEMPOTENCY_KEY_REUSED',
    'DELIVERY_PAYLOAD_CONFLICT',
    'prisma migrate deploy',
    'NOT VERIFIED',
  ])
    expect(doc).toContain(term);
  expect(doc).not.toMatch(/postgres(?:ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/);
  const readme = await readFile('examples/command-receipts/README.md', 'utf8');
  expect(readme).toContain('../../docs/raid-command-receipts.md');
});
