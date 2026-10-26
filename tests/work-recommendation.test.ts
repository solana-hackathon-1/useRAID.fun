import { describe, expect, it } from 'vitest';
import { recommend, reviewChoices, validateModelAdvice } from '../src/work-loop/recommendation';
import { publicationProblems } from '../src/work-loop/terms';
import { raidTerms } from './helpers/raid-terms-fixture';
import { exampleInput, exampleRubric } from '../examples/raid-terms/recommendation-fixture';

const policy = raidTerms().rewards[0].policy;
const choices = (over: Record<string, unknown> = {}) => ({
  difficulty: 'D',
  requiredSkills: [{ skillId: 'writing', minimumRank: 'D' }],
  participantKinds: ['HUMAN'],
  rewards: [{ policy, amount: '400000000' }],
  availableDays: 7,
  ...over,
});
describe('T017 bounded difficulty and reward recommendations', () => {
  it('returns a structured, non-authoritative estimate with its rubric version and uncertainty', () => {
    const rec = recommend(exampleInput(), exampleRubric());
    expect(rec).toMatchObject({
      status: 'ESTIMATE',
      authoritative: false,
      policyVersion: 'example-rubric-v1',
      rubricEvaluation: 'UNEVALUATED_EXAMPLE',
      difficulty: 'D',
      score: 8,
      confidence: 'MEDIUM',
    });
    expect(rec.requiredSkills).toEqual([
      { skillId: 'writing', minimumRank: 'D', verificationRequired: true },
    ]);
    expect(rec.rewardSuggestion).toMatchObject({
      status: 'RANGE',
      low: '300000000',
      high: '600000000',
      priceReference: null,
    });
    expect(rec.estimatedDurationDays).toEqual({ low: 4, high: 7 });
    expect(rec.missingInformation).toEqual([
      'Historical comparable work',
      'Available qualified capacity',
    ]);
    expect(rec.assumptions.join(' ')).toMatch(/unevaluated example/);
    // Deterministic: the same signals and rubric always give the same advice.
    expect(recommend(exampleInput(), exampleRubric())).toEqual(rec);
  });
  it('raises difficulty, routing and uncertainty as the signals grow', () => {
    const hard = recommend(
      {
        ...exampleInput(),
        integrations: 6,
        dependencies: 5,
        expectedEffortHours: 200,
        uncertainty: 'HIGH',
        consequenceOfError: 'HIGH',
        verificationCost: 'HIGH',
        deadlinePressure: 'TIGHT',
        skillDomains: [
          { skillId: 'backend', role: 'PRIMARY' },
          { skillId: 'security', role: 'SUPPORTING' },
        ],
      },
      exampleRubric(),
    );
    expect(hard.difficulty).toBe('S');
    expect(hard.participantKinds).toEqual(['HUMAN']);
    expect(hard.confidence).toBe('LOW');
    expect(hard.requiredSkills).toEqual([
      { skillId: 'backend', minimumRank: 'S', verificationRequired: true },
      { skillId: 'security', minimumRank: 'A', verificationRequired: true },
    ]);
    const easy = recommend(
      { ...exampleInput(), integrations: 0, dependencies: 0, expectedEffortHours: 4 },
      exampleRubric(),
    );
    expect(easy.difficulty).toBe('E');
    expect(easy.participantKinds).toEqual(['HUMAN', 'AI_AGENT']);
    const unrouted = recommend(
      { ...exampleInput(), preferredParticipantKinds: ['AI_INFLUENCER'] },
      exampleRubric(),
    );
    expect(unrouted.participantKinds).toEqual(['HUMAN']);
    expect(unrouted.missingInformation).toContain(
      'Preferred participant kinds are not routed for this difficulty',
    );
    expect(
      recommend({ ...exampleInput(), preferredParticipantKinds: ['AI_AGENT'] }, exampleRubric())
        .participantKinds,
    ).toEqual(['AI_AGENT']);
  });
  it('asks for missing information instead of inventing prices, effort or measurable criteria', () => {
    const {
      rewardAsset: _asset,
      budget: _budget,
      expectedEffortHours: _hours,
      ...rest
    } = exampleInput();
    const none = recommend(
      { ...rest, acceptanceCriteria: ['Make it perfect and as good as possible'] },
      exampleRubric(),
    );
    expect(none.rewardSuggestion).toEqual({ status: 'UNAVAILABLE', reason: 'NO_ASSET_SELECTED' });
    expect(none.missingInformation).toEqual(
      expect.arrayContaining([
        'Expected effort',
        'Reward asset',
        'Acceptance criterion 1 is not measurable',
      ]),
    );
    expect(none.confidence).toBe('LOW');
    // An illiquid/unpriced asset gets token units or nothing, never a fictional range.
    const other = { ...policy, assetId: { ...policy.assetId, networkIdentity: 'another-network' } };
    const unpriced = recommend({ ...exampleInput(), rewardAsset: other }, exampleRubric());
    expect(unpriced.rewardSuggestion).toEqual({ status: 'UNAVAILABLE', reason: 'NO_PRICE_BASIS' });
    expect(unpriced.missingInformation).toContain('A reviewed price basis for this asset');
  });
  it('rejects malformed inputs and rubrics, and labels rubric review honestly', () => {
    const bad =
      (input: unknown, rubric: unknown = exampleRubric()) =>
      () =>
        recommend(input, rubric);
    expect(bad({ ...exampleInput(), integrations: -1 })).toThrow('INVALID_INPUT');
    expect(bad({ ...exampleInput(), extra: true })).toThrow('INVALID_INPUT');
    expect(bad({ ...exampleInput(), skillDomains: [] })).toThrow('INVALID_INPUT');
    expect(bad({ ...exampleInput(), rewardAsset: undefined })).toThrow('INVALID_INPUT');
    expect(bad({ ...exampleInput(), budget: '0' })).toThrow('INVALID_INPUT');
    expect(bad(exampleInput(), { ...exampleRubric(), thresholds: [4, 4, 14, 22, 32] })).toThrow(
      'INVALID_INPUT',
    );
    // A reviewed rubric needs its review reference; an example must not claim one.
    expect(bad(exampleInput(), { ...exampleRubric(), evaluation: 'REVIEWED' })).toThrow(
      'INVALID_INPUT',
    );
    expect(bad(exampleInput(), { ...exampleRubric(), reviewRef: 'review-1' })).toThrow(
      'INVALID_INPUT',
    );
    const reviewed = recommend(exampleInput(), {
      ...exampleRubric(),
      evaluation: 'REVIEWED',
      reviewRef: 'review-1',
    });
    expect(reviewed.rubricEvaluation).toBe('REVIEWED');
    expect(reviewed.authoritative).toBe(false);
  });
  it('lets the Founder accept or edit the suggestion and explains every gap without blocking', () => {
    const rec = recommend(exampleInput(), exampleRubric());
    const accepted = reviewChoices(rec, choices());
    expect(accepted.gaps).toEqual([]);
    expect(accepted.fields).toEqual({
      difficulty: 'ACCEPTED',
      requiredSkills: 'ACCEPTED',
      participantKinds: 'ACCEPTED',
      reward: 'ACCEPTED',
    });
    const edited = reviewChoices(
      rec,
      choices({
        difficulty: 'B',
        requiredSkills: [{ skillId: 'other', minimumRank: 'E' }],
        participantKinds: ['HUMAN', 'AI_INFLUENCER'],
        rewards: [{ policy, amount: '100000000' }],
        availableDays: 2,
      }),
    );
    expect(edited.gaps.map((g) => g.code).sort()).toEqual(
      [
        'DEADLINE_SHORTER_THAN_ESTIMATE',
        'DIFFICULTY_ABOVE_ESTIMATE',
        'PARTICIPANT_KIND_ADDED',
        'REWARD_BELOW_RANGE',
        'SKILL_REMOVED',
      ].sort(),
    );
    expect(edited.gaps.every((g) => g.explanation.length > 20)).toBe(true);
    // The original suggestion is retained beside the final choices.
    expect(edited.suggestion).toEqual(rec);
    expect(edited.final.difficulty).toBe('B');
    expect(edited.fields.reward).toBe('EDITED');
    expect(reviewChoices(rec, choices({ difficulty: 'E' })).gaps.map((g) => g.code)).toContain(
      'DIFFICULTY_BELOW_ESTIMATE',
    );
    expect(
      reviewChoices(rec, choices({ rewards: [{ policy, amount: '900000000' }] })).gaps.map(
        (g) => g.code,
      ),
    ).toEqual(['REWARD_ABOVE_RANGE']);
    expect(
      reviewChoices(
        rec,
        choices({ requiredSkills: [{ skillId: 'writing', minimumRank: 'E' }] }),
      ).gaps.map((g) => g.code),
    ).toEqual(['SKILL_RANK_LOWERED']);
    const other = { ...policy, assetId: { ...policy.assetId, networkIdentity: 'another-network' } };
    expect(
      reviewChoices(rec, choices({ rewards: [{ policy: other, amount: '400000000' }] })).gaps.map(
        (g) => g.code,
      ),
    ).toEqual(['REWARD_ASSET_DIFFERS']);
    const noPrice = recommend({ ...exampleInput(), rewardAsset: other }, exampleRubric());
    expect(reviewChoices(noPrice, choices()).gaps.map((g) => g.code)).toEqual([
      'PRICE_UNAVAILABLE',
    ]);
    expect(() => reviewChoices({ ...rec, authoritative: true }, choices())).toThrow(
      'INVALID_INPUT',
    );
    expect(() => reviewChoices(rec, choices({ rewards: [] }))).toThrow('INVALID_INPUT');
  });
  it('keeps unevaluated model advice non-authoritative and unable to set terms', () => {
    const known = new Set(['writing', 'backend']);
    const advice = validateModelAdvice(
      {
        summary: 'Looks like a small documentation task.',
        skillHints: ['writing'],
        difficultyHint: 'D',
      },
      known,
    );
    expect(advice).toMatchObject({ status: 'UNEVALUATED_MODEL_ADVICE', authoritative: false });
    const refuse = (raw: unknown) => () => validateModelAdvice(raw, known);
    for (const forbidden of [
      { rewardAmount: '9' },
      { assetId: { mint: 'abc' } },
      { escrowAddress: 'abc' },
      { acceptedTerms: {} },
      { authoritative: true },
    ])
      expect(refuse({ summary: 'x', skillHints: [], ...forbidden })).toThrow('INVALID_INPUT');
    expect(refuse({ summary: 'x', skillHints: ['made-up-skill'] })).toThrow('INVALID_INPUT');
    expect(refuse({ summary: '', skillHints: [] })).toThrow('INVALID_INPUT');
  });
  it('never decides publication: advice and its gaps do not change the typed terms checks', () => {
    const rec = recommend(exampleInput(), exampleRubric());
    const review = reviewChoices(
      rec,
      choices({ difficulty: 'E', rewards: [{ policy, amount: '1' }] }),
    );
    expect(review.gaps.length).toBeGreaterThan(0);
    const now = new Date('2026-10-26T00:00:00.000Z');
    const before = publicationProblems(raidTerms(), now);
    recommend(exampleInput(), exampleRubric());
    expect(publicationProblems(raidTerms(), now)).toEqual(before);
  });
});
