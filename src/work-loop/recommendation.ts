import { canonicalRequestDigest } from '../command-receipts';
import { fromJsonAmount } from '../asset-registry/amounts';
import { WorkError } from './contracts';
import {
  FinalChoicesSchema,
  GapSchema,
  ModelAdviceSchema,
  RANKS,
  RecommendationInputSchema,
  RecommendationSchema,
  RubricSchema,
  type FinalChoices,
  type Gap,
  type ModelAdvice,
  type Recommendation,
  type RecommendationInput,
  type Rubric,
} from './recommendation-contracts';

type Rank = (typeof RANKS)[number];
const LEVEL = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
const PRESSURE = { NONE: 0, NORMAL: 0, TIGHT: 1 } as const;
const invalid = (): never => {
  throw new WorkError('INVALID_INPUT');
};
const rankIndex = (rank: string) => RANKS.indexOf(rank as Rank);
function effortBucket(hours: number) {
  return hours <= 8 ? 0 : hours <= 40 ? 1 : hours <= 120 ? 2 : 3;
}
/**
 * Deterministic, explainable estimate from the Founder's stated signals and a host-supplied rubric.
 * Pure: no network, model, clock or database. The result is advice (`authoritative: false`), never terms.
 */
export function recommend(rawInput: unknown, rawRubric: unknown): Recommendation {
  const input = RecommendationInputSchema.safeParse(rawInput);
  const rubric = RubricSchema.safeParse(rawRubric);
  if (!input.success || !rubric.success) return invalid();
  const i: RecommendationInput = input.data,
    r: Rubric = rubric.data;
  const w = r.weights;
  const score =
    w.integrations * i.integrations +
    w.skillDomains * i.skillDomains.length +
    w.dependencies * i.dependencies +
    w.effort * (i.expectedEffortHours === undefined ? 0 : effortBucket(i.expectedEffortHours)) +
    w.uncertainty * LEVEL[i.uncertainty] +
    w.consequence * LEVEL[i.consequenceOfError] +
    w.verification * LEVEL[i.verificationCost] +
    w.deadline * PRESSURE[i.deadlinePressure];
  const step = r.thresholds.findIndex((limit) => score <= limit);
  const difficulty: Rank = step === -1 ? 'S' : RANKS[step];
  const assumptions = [
    'Estimated only from the signals you entered; nothing was looked up or measured.',
    `Rubric ${r.version} is ${r.evaluation === 'REVIEWED' ? 'reviewed' : 'an unevaluated example, not market pricing'}.`,
  ];
  const missingInformation: string[] = [];
  if (i.expectedEffortHours === undefined) missingInformation.push('Expected effort');
  missingInformation.push('Historical comparable work', 'Available qualified capacity');
  const vague = r.vaguePhrases.map((phrase) => phrase.toLowerCase());
  i.acceptanceCriteria.forEach((criterion, index) => {
    if (vague.some((phrase) => criterion.toLowerCase().includes(phrase)))
      missingInformation.push(`Acceptance criterion ${index + 1} is not measurable`);
  });
  const requiredSkills = i.skillDomains.map((domain) => ({
    skillId: domain.skillId,
    minimumRank: RANKS[Math.max(0, rankIndex(difficulty) - (domain.role === 'PRIMARY' ? 0 : 1))],
    verificationRequired: true as const,
  }));
  const supported = r.participantKindsByRank[difficulty];
  const preferred = i.preferredParticipantKinds;
  const kinds = preferred ? supported.filter((k) => preferred.includes(k)) : supported;
  if (preferred && !kinds.length)
    missingInformation.push('Preferred participant kinds are not routed for this difficulty');
  let rewardSuggestion: Recommendation['rewardSuggestion'];
  if (!i.rewardAsset) {
    rewardSuggestion = { status: 'UNAVAILABLE', reason: 'NO_ASSET_SELECTED' };
    missingInformation.push('Reward asset');
  } else {
    const digest = canonicalRequestDigest(i.rewardAsset);
    const priced = r.rewards.find((entry) => canonicalRequestDigest(entry.policy) === digest);
    if (!priced) {
      rewardSuggestion = { status: 'UNAVAILABLE', reason: 'NO_PRICE_BASIS' };
      missingInformation.push('A reviewed price basis for this asset');
    } else {
      const band = priced.bands[difficulty];
      rewardSuggestion = {
        status: 'RANGE',
        policy: priced.policy,
        low: band.low,
        high: band.high,
        priceReference: null,
      };
    }
  }
  const low = Math.max(1, Math.ceil(score * r.durationDaysPerPoint.low));
  const high = Math.max(low, Math.ceil(score * r.durationDaysPerPoint.high));
  // Confidence is never HIGH: no comparable-work evidence exists in this estimate.
  const confidence = i.uncertainty === 'HIGH' || missingInformation.length > 3 ? 'LOW' : 'MEDIUM';
  return RecommendationSchema.parse({
    status: 'ESTIMATE',
    authoritative: false,
    difficulty,
    score,
    requiredSkills,
    participantKinds: kinds.length ? kinds : ['HUMAN'],
    rewardSuggestion,
    estimatedDurationDays: { low, high },
    confidence,
    assumptions,
    missingInformation,
    policyVersion: r.version,
    rubricEvaluation: r.evaluation,
  });
}
/**
 * Compares the Founder's final choices with the original suggestion. Differences are explained, never blocked:
 * the Founder keeps control and publication is decided only by the typed terms checks.
 */
export function reviewChoices(rawRecommendation: unknown, rawChoices: unknown) {
  const rec = RecommendationSchema.safeParse(rawRecommendation);
  const final = FinalChoicesSchema.safeParse(rawChoices);
  if (!rec.success || !final.success) return invalid();
  const s: Recommendation = rec.data,
    f: FinalChoices = final.data;
  const gaps: Gap[] = [];
  const add = (gap: Gap) => gaps.push(GapSchema.parse(gap));
  const d = rankIndex(f.difficulty) - rankIndex(s.difficulty);
  if (d < 0)
    add({
      code: 'DIFFICULTY_BELOW_ESTIMATE',
      field: 'difficulty',
      explanation: `You chose ${f.difficulty}; the estimate was ${s.difficulty}. A lower label routes the work to less experienced participants.`,
    });
  if (d > 0)
    add({
      code: 'DIFFICULTY_ABOVE_ESTIMATE',
      field: 'difficulty',
      explanation: `You chose ${f.difficulty}; the estimate was ${s.difficulty}. A higher label narrows who may take the work.`,
    });
  for (const skill of s.requiredSkills) {
    const chosen = f.requiredSkills.find((x) => x.skillId === skill.skillId);
    if (!chosen)
      add({
        code: 'SKILL_REMOVED',
        field: 'requiredSkills',
        explanation: `Suggested skill ${skill.skillId} is not required in your choices.`,
      });
    else if (rankIndex(chosen.minimumRank) < rankIndex(skill.minimumRank))
      add({
        code: 'SKILL_RANK_LOWERED',
        field: 'requiredSkills',
        explanation: `Skill ${skill.skillId} requires ${chosen.minimumRank}; the estimate was ${skill.minimumRank}.`,
      });
  }
  if (f.participantKinds.some((k) => !s.participantKinds.includes(k)))
    add({
      code: 'PARTICIPANT_KIND_ADDED',
      field: 'participantKinds',
      explanation: 'You allow participant kinds the estimate did not route to this difficulty.',
    });
  const suggestion = s.rewardSuggestion;
  if (suggestion.status === 'UNAVAILABLE')
    add({
      code: 'PRICE_UNAVAILABLE',
      field: 'reward',
      explanation:
        suggestion.reason === 'NO_ASSET_SELECTED'
          ? 'No reward asset was selected, so no range was suggested.'
          : 'No reviewed price basis exists for this asset, so your reward cannot be compared with a range.',
    });
  else {
    const digest = canonicalRequestDigest(suggestion.policy);
    const same = f.rewards.filter((leg) => canonicalRequestDigest(leg.policy) === digest);
    if (!same.length)
      add({
        code: 'REWARD_ASSET_DIFFERS',
        field: 'reward',
        explanation: 'Your reward does not use the asset the range was estimated for.',
      });
    else {
      const total = same.reduce((sum, leg) => sum + fromJsonAmount(leg.amount), 0n);
      if (total < fromJsonAmount(suggestion.low))
        add({
          code: 'REWARD_BELOW_RANGE',
          field: 'reward',
          explanation: `Your reward ${total} is below the suggested low of ${suggestion.low} base units; qualified participants may not take it.`,
        });
      if (total > fromJsonAmount(suggestion.high))
        add({
          code: 'REWARD_ABOVE_RANGE',
          field: 'reward',
          explanation: `Your reward ${total} is above the suggested high of ${suggestion.high} base units.`,
        });
    }
  }
  if (f.availableDays !== undefined && f.availableDays < s.estimatedDurationDays.low)
    add({
      code: 'DEADLINE_SHORTER_THAN_ESTIMATE',
      field: 'deadline',
      explanation: `${f.availableDays} days is shorter than the estimated minimum of ${s.estimatedDurationDays.low}.`,
    });
  const edited = (code: Gap['field']) => gaps.some((gap) => gap.field === code);
  return {
    // The original suggestion is retained next to the final choices; neither replaces the other.
    suggestion: s,
    final: f,
    fields: {
      difficulty: edited('difficulty') ? ('EDITED' as const) : ('ACCEPTED' as const),
      requiredSkills: edited('requiredSkills') ? ('EDITED' as const) : ('ACCEPTED' as const),
      participantKinds: edited('participantKinds') ? ('EDITED' as const) : ('ACCEPTED' as const),
      reward: edited('reward') ? ('EDITED' as const) : ('ACCEPTED' as const),
    },
    gaps,
  };
}
/**
 * Typed validator for an LLM's draft. It can only yield labelled, non-authoritative hints; it cannot carry an
 * amount, asset address, escrow instruction or accepted term, and it is never a price.
 */
export function validateModelAdvice(raw: unknown, knownSkillIds: ReadonlySet<string>) {
  const parsed = ModelAdviceSchema.safeParse(raw);
  if (!parsed.success) return invalid();
  const advice: ModelAdvice = parsed.data;
  if (advice.skillHints.some((id) => !knownSkillIds.has(id))) return invalid();
  return { status: 'UNEVALUATED_MODEL_ADVICE' as const, authoritative: false as const, ...advice };
}
