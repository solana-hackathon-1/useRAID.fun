import { raidTerms } from './fixture';
// EXAMPLE ONLY: synthetic weights, bands and thresholds. Not market quotes, fees or production thresholds.
const policy = raidTerms().rewards[0].policy;
const band = (low: number, high: number) => ({
  low: String(low * 100000000),
  high: String(high * 100000000),
});
export const exampleRubric = () => ({
  version: 'example-rubric-v1',
  evaluation: 'UNEVALUATED_EXAMPLE' as const,
  reviewRef: null,
  weights: {
    integrations: 2,
    skillDomains: 2,
    dependencies: 1,
    effort: 3,
    uncertainty: 2,
    consequence: 3,
    verification: 2,
    deadline: 2,
  },
  thresholds: [4, 8, 14, 22, 32] as [number, number, number, number, number],
  durationDaysPerPoint: { low: 0.4, high: 0.8 },
  participantKindsByRank: {
    E: ['HUMAN', 'AI_AGENT'],
    D: ['HUMAN', 'AI_AGENT'],
    C: ['HUMAN', 'AI_AGENT'],
    B: ['HUMAN'],
    A: ['HUMAN'],
    S: ['HUMAN'],
  },
  rewards: [
    {
      policy,
      bands: {
        E: band(1, 3),
        D: band(3, 6),
        C: band(6, 12),
        B: band(12, 25),
        A: band(25, 50),
        S: band(50, 100),
      },
    },
  ],
  vaguePhrases: ['make it perfect', 'as good as possible', 'looks great'],
});
export const exampleInput = () => ({
  outcome: 'A guide a new contributor can follow.',
  acceptanceCriteria: ['A clean installation completes using the documented steps.'],
  skillDomains: [{ skillId: 'writing', role: 'PRIMARY' as const }],
  integrations: 1,
  dependencies: 1,
  expectedEffortHours: 16,
  uncertainty: 'LOW' as const,
  consequenceOfError: 'LOW' as const,
  verificationCost: 'LOW' as const,
  deadlinePressure: 'NORMAL' as const,
  rewardAsset: raidTerms().rewards[0].policy,
  budget: '300000000',
});
