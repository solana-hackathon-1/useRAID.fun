import assert from 'node:assert/strict';
import { createSyntheticFixtures, EvidenceRecordSchema, validateScenarioPlan } from './fixtures';
import { assetKey } from './contracts';
import plan from './raid-scenarios.json';

const fixtures = createSyntheticFixtures();
const scenarios = validateScenarioPlan(plan);
const record = {
  schemaVersion: 'v1',
  simulation: true,
  assurance: 'FIXTURE_STRUCTURE',
  scenarioId: 'AC29',
  candidateSha: 'a'.repeat(40),
  environment: { kind: 'INDEPENDENT_HOST', network: 'test-only-genesis', providerVersion: 'none' },
  owner: 'AG04',
  tester: 'test-only-example',
  result: 'PASS',
  executedAt: '2026-10-08T00:00:00Z',
  expected: 'Two test mints have distinct identities',
  observed: 'Distinct keys',
  evidenceRef: 'host.ts',
}; // Illustrative record, not release evidence or a real candidate hash.
const evidence = EvidenceRecordSchema.parse(record);
const unexecutedPassRejected = !EvidenceRecordSchema.safeParse({ ...record, executedAt: null })
  .success;
assert.equal(unexecutedPassRejected, true);
console.log(
  JSON.stringify({
    simulation: fixtures.simulation,
    scenariosPlanned: scenarios.scenarios.length,
    scenariosVerified: scenarios.scenarios.filter((s) => String(s.result) === 'PASS').length,
    distinctSameSymbolAssets:
      assetKey(fixtures.assets[0].policy.assetId) !== assetKey(fixtures.assets[1].policy.assetId),
    fixtureAssurance: evidence.assurance,
    unexecutedPassRejected,
  }),
);
