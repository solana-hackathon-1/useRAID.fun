import { describe, expect, it } from 'vitest';
import {
  buildTerms,
  defaultWizardForm,
  formFromTerms,
  publicTeaser,
  rewardReview,
  type RewardAsset,
} from '../src/work-loop/creation-form';
import { RaidTermsSchema, publicationProblems } from '../src/work-loop/terms';
import { raidTerms } from './helpers/raid-terms-fixture';
import { AssetPolicySnapshotSchema } from '../src/contracts/assets';

const now = new Date('2026-10-26T10:00:00.000Z');
const solPolicy = AssetPolicySnapshotSchema.parse(raidTerms().rewards[0].policy);
const tokenPolicy = AssetPolicySnapshotSchema.parse({
  ...solPolicy,
  assetId: {
    chain: 'SOLANA' as const,
    networkIdentity: 'synthetic-work',
    kind: 'TOKEN' as const,
    mint: '11111111111111111111111111111111',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  },
  verifiedDecimals: 6,
});
const catalog: RewardAsset[] = [
  { label: 'Synthetic SOL', policy: solPolicy, funded: true },
  { label: 'Synthetic token', policy: tokenPolicy, funded: false },
];
const solKey = JSON.stringify(['SOLANA', 'synthetic-work', 'NATIVE_SOL']);
const tokenKey = JSON.stringify([
  'SOLANA',
  'synthetic-work',
  'TOKEN',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
]);
function filled() {
  return {
    ...defaultWizardForm(),
    title: 'Write a setup guide',
    publicSummary: 'A verified setup guide.',
    category: 'documentation',
    outcome: 'A guide a new contributor can follow.',
    deliverables: 'setup.md at a pinned commit\n\n',
    acceptanceCriteria: 'A clean installation completes using the documented steps.\n',
    skills: [
      { skillId: 'writing', minimumRank: 'E' as const, assessmentPolicyVersion: 'starter-v1' },
    ],
    rewards: [{ assetKey: solKey, amount: '1.5' }],
    reviewerAccountId: 'reviewer-1',
  };
}
describe('T018 wizard form, reward review and public teaser', () => {
  it('builds exact typed terms from the form with integer base units and ordered future deadlines', () => {
    const built = buildTerms(filled(), catalog, now);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(RaidTermsSchema.safeParse(built.terms).success).toBe(true);
    expect(built.terms.rewards[0].amount).toBe('1500000000');
    expect(built.terms.rewards[0].policy).toEqual(solPolicy);
    expect(built.terms.deliverables).toEqual(['setup.md at a pinned commit']);
    expect(built.terms.fees).toEqual({
      payer: 'FOUNDER',
      amount: '0',
      policy: expect.any(String),
    });
    expect(built.terms.settlementMechanism).toBe('SIMULATED');
    const d = Object.values(built.terms.deadlines).map(Date.parse);
    expect(d.every((t, i) => i === 0 || t > d[i - 1])).toBe(true);
    expect(d[0]).toBeGreaterThan(now.getTime());
    expect(publicationProblems(built.terms, now)).toEqual([]);
  });
  it('names every field problem instead of building partial terms', () => {
    const problems = (patch: object) => {
      const built = buildTerms({ ...filled(), ...patch }, catalog, now);
      return built.ok ? [] : built.problems.map((p) => p.field);
    };
    expect(problems({ title: '   ' })).toContain('title');
    expect(problems({ acceptanceCriteria: '\n\n' })).toContain('acceptanceCriteria');
    expect(problems({ skills: [] })).toContain('skills');
    expect(problems({ reviewerAccountId: '' })).toContain('reviewerAccountId');
    expect(problems({ rewards: [] })).toContain('rewards');
    expect(problems({ rewards: [{ assetKey: solKey, amount: '0' }] })).toContain('rewards');
    expect(problems({ rewards: [{ assetKey: solKey, amount: '1.1234567891' }] })).toContain(
      'rewards',
    );
    expect(problems({ rewards: [{ assetKey: solKey, amount: 'abc' }] })).toContain('rewards');
    expect(problems({ rewards: [{ assetKey: 'unknown', amount: '1' }] })).toContain('rewards');
    expect(
      problems({
        rewards: [
          { assetKey: solKey, amount: '1' },
          { assetKey: solKey, amount: '2' },
        ],
      }),
    ).toContain('rewards');
    expect(
      problems({
        days: { commitment: 3, preparation: 3, submission: 5, review: 6, operationalClosure: 7 },
      }),
    ).toContain('days');
    expect(
      problems({
        days: { commitment: 0, preparation: 1, submission: 2, review: 3, operationalClosure: 4 },
      }),
    ).toContain('days');
  });
  it('restores a saved draft into the form without losing choices', () => {
    const built = buildTerms(filled(), catalog, now);
    if (!built.ok) throw new Error('fixture');
    const form = formFromTerms(built.terms, now);
    expect(form.title).toBe('Write a setup guide');
    expect(form.deliverables).toBe('setup.md at a pinned commit');
    expect(form.rewards).toEqual([{ assetKey: solKey, amount: '1.5' }]);
    expect(form.days.commitment).toBeGreaterThan(0);
    const again = buildTerms(form, catalog, now);
    expect(again.ok && again.terms.outcome).toBe(built.terms.outcome);
  });
  it('shows the full reward vector, separate fee payer, rent and which legs are funded', () => {
    const terms = {
      ...raidTerms(),
      rewards: [
        { policy: solPolicy, amount: '1500000000' },
        { policy: tokenPolicy, amount: '2500000' },
      ],
    };
    const review = rewardReview(RaidTermsSchema.parse(terms), catalog);
    expect(review.fundingMode).toBe('SIMULATED');
    expect(review.legs.map((l) => [l.label, l.display, l.funded])).toEqual([
      ['Synthetic SOL', '1.5', true],
      ['Synthetic token', '2.5', false],
    ]);
    expect(review.coverage).toBe('PARTIAL');
    expect(review.fee).toMatchObject({ payer: 'FOUNDER', amount: '0' });
    expect(review.rent).toMatchObject({ applicable: false, payer: null });
    const all = rewardReview(RaidTermsSchema.parse(raidTerms()), catalog);
    expect(all.coverage).toBe('ALL_FUNDED');
    const none = rewardReview(RaidTermsSchema.parse(raidTerms()), []);
    expect(none.coverage).toBe('NONE');
    expect(none.legs[0]).toMatchObject({ label: 'Unrecognised asset', funded: false });
  });
  it('counts a leg as covered only for the catalog’s exact policy and one leg per asset', () => {
    const forged = AssetPolicySnapshotSchema.parse({
      ...solPolicy,
      verifiedDecimals: 0,
      registryVersion: 'forged-registry',
    });
    const forgedReview = rewardReview(
      RaidTermsSchema.parse({ ...raidTerms(), rewards: [{ policy: forged, amount: '1' }] }),
      catalog,
    );
    expect(forgedReview.legs[0].funded).toBe(false);
    expect(forgedReview.coverage).toBe('NONE');
    const twice = rewardReview(
      RaidTermsSchema.parse({
        ...raidTerms(),
        rewards: [
          { policy: solPolicy, amount: '1' },
          { policy: solPolicy, amount: '2' },
        ],
      }),
      catalog,
    );
    expect(twice.legs.map((l) => l.funded)).toEqual([false, false]);
    expect(twice.coverage).toBe('NONE');
  });
  it('exposes only an approved teaser: no private scope, reviewer, policies or funding source', () => {
    const terms = RaidTermsSchema.parse({
      ...raidTerms(),
      outcome: 'PRIVATE-OUTCOME-BYTES',
      deliverables: ['PRIVATE-DELIVERABLE'],
      acceptanceCriteria: ['PRIVATE-CRITERION'],
      exclusions: ['PRIVATE-EXCLUSION'],
      dependencies: ['PRIVATE-DEPENDENCY'],
      fundingSourceRef: 'PRIVATE-FUNDING-SOURCE',
      review: { ...raidTerms().review, reviewerAccountId: 'PRIVATE-REVIEWER' },
    });
    const text = JSON.stringify(publicTeaser(terms));
    for (const secret of [
      'PRIVATE-OUTCOME',
      'PRIVATE-DELIVERABLE',
      'PRIVATE-CRITERION',
      'PRIVATE-EXCLUSION',
      'PRIVATE-DEPENDENCY',
      'PRIVATE-FUNDING',
      'PRIVATE-REVIEWER',
      'rightsPolicy',
      'disputePolicy',
    ])
      expect(text).not.toContain(secret);
    expect(publicTeaser(terms)).toMatchObject({
      title: terms.title,
      publicSummary: terms.publicSummary,
      kind: 'PUBLIC',
    });
    const hidden = publicTeaser({ ...terms, visibility: 'CONFIDENTIAL_LISTING' });
    expect(hidden).toEqual({
      kind: 'RESTRICTED',
      title: terms.title,
      publicSummary: terms.publicSummary,
      category: terms.category,
      difficulty: terms.difficulty,
    });
  });
});
