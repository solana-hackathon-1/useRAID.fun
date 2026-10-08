import { z } from 'zod';
import { UtcTimestamp } from '../contracts';
import { ENVIRONMENTS, REQUIRED_ENVIRONMENTS } from './environments';
import { FIXTURE_IDS } from './fixtures';

const text = z.string().trim().min(1);
const ScenarioId = z.string().regex(/^AC(0[1-9]|[1-6]\d|7[0-5])$/);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
export const EvidenceRecordSchema = z
  .strictObject({
    schemaVersion: z.literal('v1'),
    simulation: z.literal(true),
    assurance: z.enum(['FIXTURE_STRUCTURE', 'SCENARIO_BEHAVIOR']),
    scenarioId: ScenarioId,
    candidateSha: Sha,
    environment: z.strictObject({
      kind: z.enum(ENVIRONMENTS),
      coveredKinds: z.array(z.enum(ENVIRONMENTS)).optional(),
      network: text,
      providerVersion: text,
    }),
    owner: text,
    tester: text,
    result: z.enum(['NOT VERIFIED', 'PASS', 'FAIL', 'BLOCKED', 'SKIPPED']),
    executedAt: UtcTimestamp.nullable(),
    expected: text,
    observed: text,
    evidenceRef: text.nullable(),
  })
  .superRefine((record, ctx) => {
    if (['PASS', 'FAIL'].includes(record.result) && (!record.executedAt || !record.evidenceRef))
      ctx.addIssue({
        code: 'custom',
        message: 'Executed results need execution time and evidence.',
      });
    if (
      record.assurance === 'FIXTURE_STRUCTURE' &&
      record.environment.kind !== 'UNIT' &&
      record.environment.kind !== 'INDEPENDENT_HOST'
    )
      ctx.addIssue({ code: 'custom', message: 'Fixture inspection proves no external boundary.' });
    if (
      record.assurance === 'SCENARIO_BEHAVIOR' &&
      ['PASS', 'FAIL'].includes(record.result) &&
      REQUIRED_ENVIRONMENTS[record.scenarioId].some(
        (kind) =>
          ![record.environment.kind, ...(record.environment.coveredKinds ?? [])].includes(kind),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Result is outside this scenario assurance boundary.',
      });
  });
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

const PlannedScenarioSchema = z.strictObject({
  id: ScenarioId,
  scenario: text,
  expected: text,
  owners: z
    .array(z.enum(['AG01', 'AG02', 'AG03', 'AG04', 'AG05', 'AG06', 'AG07', 'AG08', 'AG09', 'AG10']))
    .min(1),
  requiredEnvironments: z.array(z.enum(ENVIRONMENTS)).min(1),
  fixtures: z.array(z.enum(FIXTURE_IDS)).min(1),
  prerequisites: z.array(text).min(1),
  result: z.literal('NOT VERIFIED'),
});
const ScenarioPlanSchema = z.strictObject({
  schemaVersion: z.literal('v1'),
  simulation: z.literal(true),
  blueprintSha256: z.string().regex(/^[0-9a-f]{64}$/),
  planningCountConflict: text,
  scenarios: z.array(PlannedScenarioSchema).length(75),
});
/** Validation checks completeness/required layers; it does not execute a scenario. */
export function validateScenarioPlan(value: unknown) {
  const plan = ScenarioPlanSchema.parse(value);
  if (new Set(plan.scenarios.map((s) => s.id)).size !== 75)
    throw new Error('Missing or duplicate scenario.');
  for (const scenario of plan.scenarios)
    if (
      REQUIRED_ENVIRONMENTS[scenario.id].some(
        (kind) => !scenario.requiredEnvironments.includes(kind),
      )
    )
      throw new Error(`Missing assurance boundary for ${scenario.id}.`);
  return plan;
}
