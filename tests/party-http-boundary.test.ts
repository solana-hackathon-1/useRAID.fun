import { cp, mkdtemp, readFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('documents the replaceable Party HTTP contract and keeps the module free of application dependencies', async () => {
  const doc = await readFile('docs/raid-parties.md', 'utf8');
  for (const text of [
    'R15',
    'R16',
    'PartyHttpHost',
    'PARTY_ROSTER_WRITES_ENABLED',
    'NOT VERIFIED',
    'POST /api/v1/parties',
    'POST /api/v1/parties/{partyId}/proposals',
    'POST /api/v1/party-proposals/{proposalId}/consents',
    'GET /api/v1/party-proposals/{proposalId}',
    'Idempotency-Key',
    'Cookie',
  ])
    expect(doc, text).toContain(text);
  const reuse = await readFile('docs/raid-module-reuse.md', 'utf8');
  expect(reuse).toContain('raid-parties.md');
  expect(reuse).toContain('PartyHttpHost');
  for (const table of ['Party', 'PartyProposal', 'PartyProposalMember', 'PartyMemberConsent'])
    expect(doc, table).toContain(`"${table}"`);
  const source = await readFile('src/parties/party-http.ts', 'utf8');
  expect(source).not.toMatch(/process\.env|@prisma|from ['"]next|from ['"]\.\.\/lib\//);
  const consumer = await readFile('examples/parties/host.ts', 'utf8');
  expect(consumer).toContain('createPartyHandlers');
  expect(consumer).toContain('new Request');
  expect(consumer).not.toMatch(/process\.env|from ['"].*lib\//);
});

it('runs the transport in an independently installed host with explicit dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raid-parties-consumer-'));
  for (const name of ['host.ts', 'package.json', 'tsconfig.json'])
    await cp('examples/parties/' + name, join(dir, name));
  for (const name of [
    'contracts',
    'command-receipts',
    'asset-registry',
    'identity-locks',
    'work-loop',
    'work-http',
    'http-contracts',
    'parties',
    'skills',
  ])
    await cp('examples/parties/' + name, join(dir, name), { recursive: true, dereference: true });
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  const output = execFileSync(
    process.execPath,
    [join(dir, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
    { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test' } },
  );
  expect(JSON.parse(output)).toEqual({
    synthetic: true,
    distributedCoverageIsExplicit: true,
    partyLabelManufacturesNoSkill: true,
    leaderCannotStandInForMember: true,
    consentNamesNoParticipant: true,
    exactIntegerAllocations: true,
    httpBindsPathIdsAndSession: true,
    httpRefusesSubstitutedResults: true,
  });
}, 30000);
