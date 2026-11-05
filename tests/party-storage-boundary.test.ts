import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import { assertTestDatabase } from './helpers/db-guard';

// The only modules the Party sources may import: shared pure contracts, the command-receipt and work-loop
// authority ports, the skill eligibility explanation, and the Party module itself. Nothing application-global.
const ALLOWED_IMPORT =
  /^(zod|\.\/[a-z-]+|\.\.\/(command-receipts|contracts\/[a-z-]+|http-contracts\/json|skills\/eligibility(-requirement)?|work-loop\/(contracts|engagement-authority)))$/;
const imports = (source: string) =>
  [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

it('documents the Parties reuse contract, host dependencies and database-guard caveats', async () => {
  const reuse = await readFile('docs/raid-module-reuse.md', 'utf8');
  const entry = reuse.slice(reuse.indexOf('## Parties (party-storage)'));
  expect(entry.startsWith('## Parties (party-storage)')).toBe(true);
  for (const term of [
    // stable exports
    'createParty',
    'proposePartyRoster',
    'recordPartyMemberConsent',
    'readPartyProposal',
    'evaluatePartyCoverage',
    'createPartyHandlers',
    'PartyHost',
    'PartyHttpHost',
    // explicit host dependencies and host-supplied tables, ports and receipts
    'CommandReceiptTransaction',
    'CommandReceipt',
    'identity locks',
    '"WorkListing"',
    '"RaidSlot"',
    '"TermsVersion"',
    '"PartyMemberConsent"',
    '202610290002_parties',
    'PARTY_ROSTER_WRITES_ENABLED',
    // the database-guard caveats (#340 NOTE 4 and 5)
    'not an authenticated identity',
    'session_replication_role',
    'DISABLE TRIGGER',
    'snapshotDigest',
    'canonical SHA-256',
    'NOT VERIFIED',
    // the consuming example
    'examples/party-storage',
    'tests/party-storage-boundary.test.ts',
  ])
    expect(entry, term).toContain(term);
  const doc = await readFile('docs/raid-parties.md', 'utf8');
  expect(doc).toContain('examples/party-storage');
  expect(doc).toContain('R15');
  expect(doc).toContain('R16');
});

it('keeps the Party sources free of application dependencies', async () => {
  const files = (await readdir('src/parties')).filter((name) => name.endsWith('.ts')).sort();
  expect(files).toEqual(
    expect.arrayContaining([
      'contracts.ts',
      'index.ts',
      'party-coverage.ts',
      'party-http.ts',
      'party-storage.ts',
    ]),
  );
  for (const file of files) {
    const source = await readFile(join('src/parties', file), 'utf8');
    expect(source, file).not.toMatch(
      /process\.env|globalThis|@prisma|@\/|from ['"]next|from ['"](\.\.\/)+lib\/|from ['"]\.\.\/(app|components|db)/,
    );
    for (const specifier of imports(source)) expect(specifier, file).toMatch(ALLOWED_IMPORT);
  }
  // The storage reaches the host only through the injected transaction and PartyHost, never a module singleton.
  const storage = await readFile('src/parties/party-storage.ts', 'utf8');
  for (const port of ['CommandReceiptTransaction', 'PartyHost', 'allowNewWrites'])
    expect(storage).toContain(port);
});

it('has a consuming host that uses only the public Party interface', async () => {
  const entries = (await readdir('examples/party-storage')).sort();
  expect(entries).toEqual(
    expect.arrayContaining([
      'README.md',
      'connection.ts',
      'host.ts',
      'migrate.ts',
      'migrations',
      'package.json',
      'schema.sql',
    ]),
  );
  const host = await readFile('examples/party-storage/host.ts', 'utf8');
  for (const call of [
    'createParty',
    'proposePartyRoster',
    'recordPartyMemberConsent',
    'readPartyProposal',
  ])
    expect(host).toContain(call);
  expect(host).not.toMatch(/process\.env|from ['"].*\/lib\/|from ['"]@\//);
  for (const specifier of imports(host))
    expect(specifier).toMatch(/^(node:[a-z/]+|\.\/.+|@prisma\/client)$/);
  const readme = await readFile('examples/party-storage/README.md', 'utf8');
  for (const term of ['useraid_party_storage_host_test', 'npm run migrate', 'party-storage'])
    expect(readme).toContain(term);
  // The migrations are the repository's own, linked rather than copied, so they cannot drift.
  expect((await readdir('examples/party-storage/migrations')).sort()).toEqual(
    expect.arrayContaining(['capacity.sql', 'parties.sql', 'receipts.sql', 'terms.sql']),
  );
});

it.skipIf(process.env.RUN_DB_TESTS !== 'true')(
  'runs the Party commands in an independently installed host against its own database',
  async () => {
    assertTestDatabase();
    const name = 'useraid_party_storage_host_test_' + randomBytes(4).toString('hex');
    const admin = new PrismaClient({ log: [] });
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = '/' + name;
    const directory = await mkdtemp(join(tmpdir(), 'raid-party-storage-consumer-'));
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      await cp('examples/party-storage', directory, { recursive: true, dereference: true });
      await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
      const run = (script: string) =>
        execFileSync(process.execPath, [join(directory, 'node_modules/tsx/dist/cli.mjs'), script], {
          cwd: directory,
          encoding: 'utf8',
          timeout: 60000,
          env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: url.toString() },
        });
      run('migrate.ts');
      expect(JSON.parse(run('host.ts'))).toEqual({
        synthetic: true,
        ownDatabase: true,
        leaderOwnsParty: true,
        exactSplitRequired: true,
        staleDigestRefused: true,
        outsiderLearnsNothing: true,
        consentIsTheMembersOwn: true,
        directForgeryRefusedByDatabase: true,
        replayWithWritesOff: true,
        acceptsNothing: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$disconnect();
    }
  },
  90000,
);
