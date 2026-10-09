import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { assertTestDatabase } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const NEW_MIGRATION = '202610090003_wallet_links';
// SHA-256 of every earlier migration file at the time the wallet-link slice was written.
// Applied migrations are immutable; this proves the slice only added a migration.
const EARLIER: Record<string, string> = {
  '202609270001_init': '6097b1b9b32535a9e8dfb2a4694fc48c9d26a7ae749fc0986b1b8ed12bbb821f',
  '202609280001_x_connection': '846ffa673555539710687f9265ceaa10ee6c4d8a0d2cc57b8f81fd839afa2603',
  '202609280002_pump_launch': '15c34a12f5effed2d20dad6848b955ff444defb33365797480f7d1a11f7bf020',
  '202609290001_x_tracking': '2ecd1549904bc3ee9fd4eba19cf75935540ea04380607b27b5cd364a9fb0032f',
  '202609290002_standalone_raids':
    'a68b159e961c563092bcb95290c4fa6feb9cc557d2fb29abe9daaaa9ee2eea0b',
  '202609300001_creator_studio': '5d9896bcd2f706c769c42eb0a67639bbaac0f2d5ceb1d84f9c8e4ca6b8e2f7de',
  '202610020001_studio_fk_alignment':
    '0e3254751a38d9224aa25ad3bcd9c22dc18d8d324b18c0f33224aa3a484fa7f4',
  '202610020002_job_dead_letter':
    'f80f7bd422d3fd391ec4cc30b3f7105466161109c675e7b368ca1756fa5ec3e8',
  '202610020003_x_budget_controls':
    'f46c859300bb0b4bf34bda5e6874b9b808175ef0565f0a70edac0bdf586e71b9',
  '202610020004_raid_money_policies':
    'abb5f5e5eecdbaf6eef1549f60db1735be44a8ae14c5de6cc6cfb46eec261854',
  '202610020005_token_metadata_source':
    'd63b30ad51030236405279c3d6a09b29d020ca1bc7f83dc01fc2b33fde9b1d07',
  '202610020006_auth_hardening': '2291eae6911d4e097dd2f403a1f26de0935d69c53d7c7563e8be6cc3de62e63e',
  '202610020007_media_assets': '1747bf415b9e1ccdc6e3d24e2d0ae54caf2eaa76ec0ab1b0bd1fd7f6052cd46d',
  '202610020008_wallet_rotation':
    'a65464300afc8ff5e9a304b02603f14c876e8ddd92b276ad7d462de1f47047b6',
  '202610020009_launch_finance_hardening':
    '277719f448879a3aeb449dc6efc404b7f2aee3519e5997b6e17b65a27ceef027',
  '202610020010_hot_path_indexes':
    '4f73dba4ae3f5805b3a718942fff9cad4482c95830c0b33f2f9b5ed54fa77f8c',
  '202610020011_ledger_integrity':
    '8b94c4b55ac388f72eedc9ebafdcd19736cba4c9e7b74da5ff989ae46a56b0af',
  '202610020012_state_checks': '950310190fd896aab69ceef02a9a012c9e958754f7e05dba6e9a3d203a0535b1',
  '202610080001_participant_mapping':
    '495f5086553af2b9d64121d0fcd555e18bb1e1c693acfc0cd6aca9544922f259',
};
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();

describe('wallet-link migration source', () => {
  it('keeps every earlier applied migration byte-for-byte', () => {
    for (const [name, hash] of Object.entries(EARLIER))
      expect(sha(`prisma/migrations/${name}/migration.sql`), name).toBe(hash);
    const present = readdirSync('prisma/migrations').filter((entry) => /^\d{12}_/.test(entry));
    expect(present).toContain(NEW_MIGRATION);
  });

  it('executes exactly the reviewed proposal statements (header and comments may differ)', () => {
    const proposal = readFileSync('planning/migration-proposals/T006-wallet-links.sql', 'utf8');
    const migration = readFileSync(`prisma/migrations/${NEW_MIGRATION}/migration.sql`, 'utf8');
    expect(statements(migration)).toBe(statements(proposal));
    expect(migration).not.toMatch(/PROPOSED \/ NOT REVIEWED \/ NOT APPLIED/);
    expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });

  it('declares the composite participant relation with the SQL constraint name (WR02)', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    expect(schema).toContain('model WalletLink');
    expect(schema).toContain('map: "WalletLink_participant_fkey"');
    expect(schema).toContain('@@unique([id, accountId])');
  });
});

integration('wallet-link migration on a scratch database (D14)', () => {
  it('applies twice, matches the Prisma schema with no drift, and records one row per migration', async () => {
    assertTestDatabase();
    const base = new URL(process.env.DATABASE_URL!);
    const scratchName = 'useraid_t006_links_scratch';
    const scratch = new URL(base);
    scratch.pathname = `/${scratchName}`;
    const admin = new PrismaClient({ log: [] });
    const run = (args: string[], url: URL) =>
      execFileSync('npx', ['prisma', ...args], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: url.toString() },
        timeout: 120000,
      });
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}"`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
      const first = run(['migrate', 'deploy'], scratch);
      expect(first).toContain('All migrations have been successfully applied');
      expect(run(['migrate', 'deploy'], scratch)).toContain('No pending migrations to apply');
      const diff = execFileSync(
        'npx',
        [
          'prisma',
          'migrate',
          'diff',
          '--from-url',
          scratch.toString(),
          '--to-schema-datamodel',
          'prisma/schema.prisma',
          '--exit-code',
        ],
        { encoding: 'utf8', timeout: 120000 },
      );
      expect(diff).toContain('No difference detected');
      const probe = new PrismaClient({ datasources: { db: { url: scratch.toString() } }, log: [] });
      try {
        const applied = await probe.$queryRawUnsafe<{ count: number }[]>(
          'SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
        );
        const expected = readdirSync('prisma/migrations').filter((entry) =>
          /^\d{12}_/.test(entry),
        ).length;
        expect(applied[0].count).toBe(expected);
        const link = await probe.$queryRawUnsafe<{ regclass: string | null }[]>(
          `SELECT to_regclass('public."WalletLink"')::text AS regclass`,
        );
        expect(link[0].regclass).toBe('"WalletLink"');
      } finally {
        await probe.$disconnect();
      }
      // The shared test database must also be in sync (applied by the same migrations).
      expect(
        execFileSync(
          'npx',
          [
            'prisma',
            'migrate',
            'diff',
            '--from-url',
            base.toString(),
            '--to-schema-datamodel',
            'prisma/schema.prisma',
            '--exit-code',
          ],
          { encoding: 'utf8', timeout: 120000 },
        ),
      ).toContain('No difference detected');
    } finally {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
      await admin.$disconnect();
    }
  }, 300000);
});
