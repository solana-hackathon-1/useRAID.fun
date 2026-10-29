import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, testDatabaseName } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('legacy auth hosts own required READ COMMITTED instead of database defaults', () => {
  const db = new PrismaClient({ log: [] });
  beforeAll(() => assertTestDatabase());
  afterAll(() => db.$disconnect());

  it.each(['repeatable read', 'serializable'] as const)(
    'preserves permitted wallet and X account folds under database default %s',
    async (isolation) => {
      // Explicit test database only. Child processes give both composing hosts fresh connections;
      // changing a connection-local GUC on an arbitrary pooled connection would not prove this.
      assertTestDatabase();
      const directory = await mkdtemp(join(tmpdir(), 'raid-auth-isolation-'));
      const before = await db.$queryRawUnsafe<{ transaction_isolation: string }[]>(
        'SHOW transaction_isolation',
      );
      const previous = before[0].transaction_isolation;
      expect(['read committed', 'repeatable read', 'serializable']).toContain(previous);
      try {
        await db.$executeRawUnsafe(
          `ALTER DATABASE "${testDatabaseName()}" SET default_transaction_isolation TO '${isolation}'`,
        );
        await db.$disconnect();
        expect(
          (
            await db.$queryRawUnsafe<{ transaction_isolation: string }[]>(
              'SHOW transaction_isolation',
            )
          )[0].transaction_isolation,
        ).toBe(isolation);
        const report = join(directory, 'auth-folds.xml');
        const output = execFileSync(
          process.execPath,
          [
            'node_modules/vitest/vitest.mjs',
            'run',
            'tests/wallet-auth-db.test.ts',
            'tests/x-oauth-db.test.ts',
            '--testNamePattern',
            'moves a wallet from an empty wallet-only account|signs in as the existing X account and takes over the wallet',
            '--reporter=default',
            '--reporter=junit',
            `--outputFile=${report}`,
          ],
          { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 30000 },
        );
        // Assertions are the unchanged real account-fold behaviors in each named child suite.
        expect(output).toMatch(/2 passed/);
        const xml = await readFile(report, 'utf8');
        expect(xml).not.toContain('<failure');
        expect(xml).not.toContain('<error');
      } finally {
        await db.$executeRawUnsafe(
          `ALTER DATABASE "${testDatabaseName()}" SET default_transaction_isolation TO '${previous}'`,
        );
        await db.$disconnect();
        await rm(directory, { recursive: true, force: true });
      }
    },
    40000,
  );
});
