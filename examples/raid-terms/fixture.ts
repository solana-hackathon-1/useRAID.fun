// Synthetic deadlines stay relative to this test process, never to a release date.
const origin = new Date();
origin.setUTCHours(0, 0, 0, 0);
const deadline = (days: number) => new Date(origin.getTime() + days * 86400000).toISOString();
export const raidTerms = () => ({
  version: 'v1' as const,
  title: 'Synthetic documentation task',
  publicSummary: 'Write a verified setup guide.',
  category: 'documentation',
  outcome: 'A guide a new contributor can follow.',
  deliverables: ['setup.md at a pinned commit'],
  acceptanceCriteria: ['A clean installation completes using the documented steps.'],
  exclusions: ['No production changes'],
  dependencies: ['Public synthetic repository'],
  difficulty: 'E',
  requiredSkills: [{ skillId: 'writing', minimumRank: 'E', assessmentPolicyVersion: 'starter-v1' }],
  participantKinds: ['HUMAN'],
  execution: 'SOLO',
  admission: 'INSTANT',
  visibility: 'PUBLIC',
  allowedToolsPolicy: 'Public tools allowed; disclose AI assistance.',
  deadlines: {
    commitment: deadline(6),
    preparation: deadline(7),
    submission: deadline(8),
    review: deadline(9),
    operationalClosure: deadline(10),
  },
  startCondition: 'Verified binding and required resources ready.',
  review: {
    reviewerAccountId: 'reviewer',
    evidence: 'Pinned commit plus installation output.',
    maxRevisionRounds: 1,
  },
  rightsPolicy: 'Contributor retains pre-existing IP; synthetic deliverable licensed MIT.',
  portfolioPolicy: 'Public synthetic deliverable may be shown.',
  withdrawalPolicy: 'May withdraw; recorded outcome, settlement resolved separately.',
  terminationPolicy: 'Finite operational closure; no fault or money decided by silence.',
  disputePolicy: 'Manual evidence review; no settlement authority supplied by this prototype.',
  finalityPolicy: 'Simulated only; no claimable live funds.',
  rewards: [
    {
      policy: {
        assetId: { chain: 'SOLANA', networkIdentity: 'synthetic-work', kind: 'NATIVE_SOL' },
        registryVersion: 'synthetic-v1',
        verifiedDecimals: 9,
        observedAuthorities: [],
        supportedExtensionProfile: 'native',
        observedAt: '2026-10-26T00:00:00.000Z',
        observedSlot: '0',
      },
      amount: '1000000000',
    },
  ],
  fees: { payer: 'FOUNDER', amount: '0', policy: 'No fees in this synthetic host.' },
  fundingSourceRef: 'synthetic-reserve-1',
  settlementMechanism: 'SIMULATED',
});
