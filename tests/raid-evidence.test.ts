import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EvidenceRecordSchema, validateScenarioPlan } from './fixtures/raid';
import plan from '../planning/raid-scenarios.json';

const record = {
  schemaVersion: 'v1',
  simulation: true,
  assurance: 'FIXTURE_STRUCTURE',
  scenarioId: 'AC29',
  candidateSha: 'a'.repeat(40),
  environment: { kind: 'UNIT', network: 'test-only-genesis', providerVersion: 'none' },
  owner: 'AG04',
  tester: 'local-test-host',
  result: 'PASS',
  executedAt: '2026-10-08T00:00:00Z',
  expected: 'Synthetic mints have different asset keys',
  observed: 'Two different keys',
  evidenceRef: 'tests/raid-fixtures.test.ts',
};

describe('T004 evidence cannot promote fixtures into actual scenario assurance', () => {
  it('records exact SHA/environment/scenario/result and preserves fixture-only assurance', () => {
    expect(EvidenceRecordSchema.parse(record)).toEqual(record);
  });
  it.each([
    'candidateSha',
    'scenarioId',
    'environment',
    'tester',
    'expected',
    'observed',
    'evidenceRef',
    'executedAt',
  ])('rejects missing executed metadata %s', (field) => {
    const invalid: Record<string, unknown> = { ...record };
    delete invalid[field];
    expect(EvidenceRecordSchema.safeParse(invalid).success).toBe(false);
  });
  it.each(['abc', 'A'.repeat(40), 'g'.repeat(40)])('rejects invalid SHA %s', (candidateSha) => {
    expect(EvidenceRecordSchema.safeParse({ ...record, candidateSha }).success).toBe(false);
  });
  it('rejects PASS without an execution, invented production environment or approval fields', () => {
    expect(EvidenceRecordSchema.safeParse({ ...record, executedAt: null }).success).toBe(false);
    expect(EvidenceRecordSchema.safeParse({ ...record, simulation: false }).success).toBe(false);
    expect(
      EvidenceRecordSchema.safeParse({
        ...record,
        environment: { ...record.environment, kind: 'PRODUCTION' },
      }).success,
    ).toBe(false);
    expect(EvidenceRecordSchema.safeParse({ ...record, businessApproved: true }).success).toBe(
      false,
    );
  });
  it('accepts honest planned/blocked/skipped evidence without labeling execution', () => {
    for (const result of ['NOT VERIFIED', 'BLOCKED', 'SKIPPED'])
      expect(
        EvidenceRecordSchema.safeParse({ ...record, result, executedAt: null, evidenceRef: null })
          .success,
      ).toBe(true);
  });
  it('rejects fixture PASS as a DB/program/provider/recovery scenario result', () => {
    for (const [scenarioId, kind] of [
      ['AC11', 'UNIT'],
      ['AC31', 'REAL_DB'],
      ['AC42', 'UNIT'],
      ['AC68', 'UNIT'],
    ])
      expect(
        EvidenceRecordSchema.safeParse({
          ...record,
          assurance: 'SCENARIO_BEHAVIOR',
          scenarioId,
          environment: { ...record.environment, kind },
        }).success,
      ).toBe(false);
  });
  it('validates an actually executed result at its required environment without granting release approval', () => {
    expect(
      EvidenceRecordSchema.safeParse({
        ...record,
        assurance: 'SCENARIO_BEHAVIOR',
        scenarioId: 'AC11',
        environment: { ...record.environment, kind: 'REAL_DB' },
      }).success,
    ).toBe(true);
  });
});

describe('T004 canonical scenario responsibility and environment plan', () => {
  const blueprint = readFileSync('RAID_AGENT_BLUEPRINT.md', 'utf8');
  const canonical = [...blueprint.matchAll(/^\| (AC\d{2})\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$/gm)].map(
    (m) => ({ id: m[1], scenario: m[2], expected: m[3] }),
  );
  it('covers all 75 current canonical scenarios including the three reuse/TDD additions', () => {
    expect(canonical).toHaveLength(75);
    expect(
      plan.scenarios.map(({ id, scenario, expected }) => ({ id, scenario, expected })),
    ).toEqual(canonical);
    expect(() => validateScenarioPlan(plan)).not.toThrow();
    expect(
      plan.scenarios.every(
        (s) =>
          s.result === 'NOT VERIFIED' &&
          s.owners.length > 0 &&
          s.requiredEnvironments.length > 0 &&
          s.fixtures.length > 0,
      ),
    ).toBe(true);
  });
  it('rejects missing, duplicate or falsely passing planned scenarios', () => {
    expect(() => validateScenarioPlan({ ...plan, scenarios: plan.scenarios.slice(1) })).toThrow();
    expect(() =>
      validateScenarioPlan({ ...plan, scenarios: [...plan.scenarios, plan.scenarios[0]] }),
    ).toThrow();
    expect(() =>
      validateScenarioPlan({
        ...plan,
        scenarios: plan.scenarios.map((s, i) => (i ? s : { ...s, result: 'PASS' })),
      }),
    ).toThrow();
  });
  it('requires real boundaries for capacity races, chain money, private payloads and durability', () => {
    const environmentFor = (id: string) =>
      plan.scenarios.find((s) => s.id === id)!.requiredEnvironments;
    expect(environmentFor('AC11')).toContain('REAL_DB');
    expect(environmentFor('AC31')).toContain('PROGRAM');
    expect(environmentFor('AC42')).toEqual(expect.arrayContaining(['REAL_DB', 'BROWSER']));
    expect(environmentFor('AC68')).toContain('RECOVERY');
    const weak = {
      ...plan,
      scenarios: plan.scenarios.map((s) =>
        s.id === 'AC11' ? { ...s, requiredEnvironments: ['UNIT'] } : s,
      ),
    };
    expect(() => validateScenarioPlan(weak)).toThrow();
  });
});
