import { cp, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabase } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const EXAMPLE_DB = 'raid_terms_example';
const db = new PrismaClient();
let dir = '';
/**
 * The independent raid-terms host (examples/raid-terms) is the proof that the work-loop modules install and run
 * outside the application: a copy of the directory with symlinks dereferenced, its own `npm ci`, an empty loopback
 * database named raid_terms_example, and only the migrations the example itself lists. A library change that needs a
 * new migration (or a new host port) the example does not carry fails here, not in a reader's checkout.
 */
integration('raid-terms consuming example (independent PostgreSQL host)', () => {
  beforeAll(async () => {
    assertTestDatabase();
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${EXAMPLE_DB}" WITH (FORCE)`);
    await db.$executeRawUnsafe(`CREATE DATABASE "${EXAMPLE_DB}"`);
    dir = await mkdtemp(join(tmpdir(), 'raid-terms-example-'));
    await cp('examples/raid-terms', dir, { recursive: true, dereference: true });
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: dir,
      stdio: 'pipe',
    });
  }, 180000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${EXAMPLE_DB}" WITH (FORCE)`);
    await db.$disconnect();
  });
  it('runs the whole work loop, including closure, from only its own listed migrations', () => {
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = '/' + EXAMPLE_DB;
    url.search = '';
    const output = execFileSync(
      process.execPath,
      [join(dir, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: url.toString() },
        timeout: 120000,
      },
    );
    expect(output).toContain('PASS: independent PG host');
    expect(output).toContain('SIMULATED ONLY');
  }, 150000);
});
