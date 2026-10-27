import {
  assetKey,
  formatDisplayAmount,
  parseDisplayAmount,
  type AssetPolicySnapshot,
} from '../contracts/assets';
import type { SkillRank } from '../contracts/entities';
import { RaidTermsSchema, type RaidTerms } from './terms';

/** An asset the host can offer as a reward. `funded` means the host's simulated reserve covers it. */
export interface RewardAsset {
  label: string;
  policy: AssetPolicySnapshot;
  funded: boolean;
}
export interface WizardForm {
  title: string;
  publicSummary: string;
  category: string;
  outcome: string;
  /** One item per line. */
  deliverables: string;
  acceptanceCriteria: string;
  exclusions: string;
  dependencies: string;
  difficulty: SkillRank;
  skills: { skillId: string; minimumRank: SkillRank; assessmentPolicyVersion: string }[];
  admission: 'INSTANT' | 'APPLICATION';
  visibility: 'PUBLIC' | 'TRUSTED_LISTING' | 'CONFIDENTIAL_LISTING' | 'INVITE_ONLY';
  /** Display-unit amounts; converted to exact base units with the asset's verified decimals. */
  rewards: { assetKey: string; amount: string }[];
  reviewerAccountId: string;
  reviewEvidence: string;
  maxRevisionRounds: number;
  /** Whole days from now; strictly increasing. */
  days: {
    commitment: number;
    preparation: number;
    submission: number;
    review: number;
    operationalClosure: number;
  };
  allowedToolsPolicy: string;
  startCondition: string;
  rightsPolicy: string;
  portfolioPolicy: string;
  withdrawalPolicy: string;
  terminationPolicy: string;
  disputePolicy: string;
  finalityPolicy: string;
  fundingSourceRef: string;
}
export interface FieldProblem {
  field: string;
  message: string;
}
const DAY = 86400000;
const MAXIMUM = 2n ** 64n - 1n;
export function defaultWizardForm(): WizardForm {
  return {
    title: '',
    publicSummary: '',
    category: '',
    outcome: '',
    deliverables: '',
    acceptanceCriteria: '',
    exclusions: '',
    dependencies: '',
    difficulty: 'E',
    skills: [{ skillId: '', minimumRank: 'E', assessmentPolicyVersion: 'starter-v1' }],
    admission: 'INSTANT',
    visibility: 'PUBLIC',
    rewards: [],
    reviewerAccountId: '',
    reviewEvidence:
      'Pinned commit or artifact version plus the output that shows each criterion met.',
    maxRevisionRounds: 2,
    days: { commitment: 6, preparation: 7, submission: 14, review: 17, operationalClosure: 21 },
    allowedToolsPolicy: 'Public tools allowed; disclose AI assistance.',
    startCondition: 'Verified binding and required resources ready.',
    rightsPolicy:
      'Contributor retains pre-existing IP; deliverable licensed as stated in the brief.',
    portfolioPolicy: 'Public deliverable may be shown in the contributor portfolio.',
    withdrawalPolicy:
      'May withdraw; the outcome is recorded and settlement is resolved separately.',
    terminationPolicy: 'Finite operational closure; no fault or money is decided by silence.',
    disputePolicy: 'Manual evidence review; no settlement authority is supplied by this milestone.',
    finalityPolicy: 'Simulated only; no claimable live funds.',
    fundingSourceRef: 'simulated-reserve',
  };
}
const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const FIELD: Record<string, string> = {
  requiredSkills: 'skills',
  deadlines: 'days',
  review: 'reviewEvidence',
  rewards: 'rewards',
};
/** Typed terms from the form, or every field problem. The server re-validates and decides publication. */
export function buildTerms(
  form: WizardForm,
  catalog: readonly RewardAsset[],
  now: Date,
): { ok: true; terms: RaidTerms } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  const d = form.days;
  const order = [d.commitment, d.preparation, d.submission, d.review, d.operationalClosure];
  if (
    order.some((day) => !Number.isInteger(day) || day < 1 || day > 3650) ||
    order.some((day, i) => i > 0 && day <= order[i - 1])
  )
    add(
      'days',
      'Deadlines must be whole days from now and strictly increasing. The saved deadlines may have passed or rounded to the same day; choose a new schedule before saving.',
    );
  const rewards: { policy: AssetPolicySnapshot; amount: string }[] = [];
  if (!form.rewards.length) add('rewards', 'Add at least one reward.');
  const seen = new Set<string>();
  for (const leg of form.rewards) {
    const asset = catalog.find((entry) => assetKey(entry.policy.assetId) === leg.assetKey);
    if (!asset) {
      add('rewards', 'Choose a listed reward asset.');
      continue;
    }
    if (seen.has(leg.assetKey)) add('rewards', 'Each asset can appear once in the reward.');
    seen.add(leg.assetKey);
    try {
      const amount = parseDisplayAmount(leg.amount.trim(), asset.policy.verifiedDecimals, MAXIMUM);
      if (BigInt(amount) <= 0n) throw new Error('zero');
      rewards.push({ policy: asset.policy, amount });
    } catch {
      add(
        'rewards',
        `Enter a positive amount with at most ${asset.policy.verifiedDecimals} decimal places for ${asset.label}.`,
      );
    }
  }
  const at = (days: number) => new Date(now.getTime() + days * DAY).toISOString();
  const parsed = RaidTermsSchema.safeParse({
    version: 'v1',
    title: form.title.trim(),
    publicSummary: form.publicSummary.trim(),
    category: form.category.trim(),
    outcome: form.outcome.trim(),
    deliverables: lines(form.deliverables),
    acceptanceCriteria: lines(form.acceptanceCriteria),
    exclusions: lines(form.exclusions),
    dependencies: lines(form.dependencies),
    difficulty: form.difficulty,
    requiredSkills: form.skills.map((skill) => ({
      skillId: skill.skillId.trim(),
      minimumRank: skill.minimumRank,
      assessmentPolicyVersion: skill.assessmentPolicyVersion.trim(),
    })),
    participantKinds: ['HUMAN'],
    execution: 'SOLO',
    admission: form.admission,
    visibility: form.visibility,
    allowedToolsPolicy: form.allowedToolsPolicy.trim(),
    deadlines: {
      commitment: at(d.commitment),
      preparation: at(d.preparation),
      submission: at(d.submission),
      review: at(d.review),
      operationalClosure: at(d.operationalClosure),
    },
    startCondition: form.startCondition.trim(),
    review: {
      reviewerAccountId: form.reviewerAccountId.trim(),
      evidence: form.reviewEvidence.trim(),
      maxRevisionRounds: form.maxRevisionRounds,
    },
    rightsPolicy: form.rightsPolicy.trim(),
    portfolioPolicy: form.portfolioPolicy.trim(),
    withdrawalPolicy: form.withdrawalPolicy.trim(),
    terminationPolicy: form.terminationPolicy.trim(),
    disputePolicy: form.disputePolicy.trim(),
    finalityPolicy: form.finalityPolicy.trim(),
    rewards,
    fees: { payer: 'FOUNDER', amount: '0', policy: 'No fees in this simulated milestone.' },
    fundingSourceRef: form.fundingSourceRef.trim(),
    settlementMechanism: 'SIMULATED',
  });
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const head = String(issue.path[0] ?? 'terms');
      const field =
        head === 'review' && issue.path[1] === 'reviewerAccountId'
          ? 'reviewerAccountId'
          : head === 'review' && issue.path[1] === 'maxRevisionRounds'
            ? 'maxRevisionRounds'
            : (FIELD[head] ?? head);
      if (!problems.some((p) => p.field === field)) add(field, 'Check this field.');
    }
  return problems.length || !parsed.success
    ? { ok: false, problems }
    : { ok: true, terms: parsed.data };
}
/** A saved draft back into the form, so a reload or a failure never loses the Founder's choices. */
export function formFromTerms(terms: RaidTerms, now: Date): WizardForm {
  const days = (iso: string) => Math.max(1, Math.ceil((Date.parse(iso) - now.getTime()) / DAY));
  return {
    ...defaultWizardForm(),
    title: terms.title,
    publicSummary: terms.publicSummary,
    category: terms.category,
    outcome: terms.outcome,
    deliverables: terms.deliverables.join('\n'),
    acceptanceCriteria: terms.acceptanceCriteria.join('\n'),
    exclusions: terms.exclusions.join('\n'),
    dependencies: terms.dependencies.join('\n'),
    difficulty: terms.difficulty,
    skills: terms.requiredSkills.map((skill) => ({ ...skill })),
    admission: terms.admission,
    visibility: terms.visibility,
    rewards: terms.rewards.map((leg) => ({
      assetKey: assetKey(leg.policy.assetId),
      amount: formatDisplayAmount(leg.amount, leg.policy.verifiedDecimals),
    })),
    reviewerAccountId: terms.review.reviewerAccountId,
    reviewEvidence: terms.review.evidence,
    maxRevisionRounds: terms.review.maxRevisionRounds,
    days: {
      commitment: days(terms.deadlines.commitment),
      preparation: days(terms.deadlines.preparation),
      submission: days(terms.deadlines.submission),
      review: days(terms.deadlines.review),
      operationalClosure: days(terms.deadlines.operationalClosure),
    },
    allowedToolsPolicy: terms.allowedToolsPolicy,
    startCondition: terms.startCondition,
    rightsPolicy: terms.rightsPolicy,
    portfolioPolicy: terms.portfolioPolicy,
    withdrawalPolicy: terms.withdrawalPolicy,
    terminationPolicy: terms.terminationPolicy,
    disputePolicy: terms.disputePolicy,
    finalityPolicy: terms.finalityPolicy,
    fundingSourceRef: terms.fundingSourceRef,
  };
}
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? '[' + value.map(stable).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k]))
          .join(',') +
        '}'
      : JSON.stringify(value);
/** Exact policy snapshot equality (decimals, registry version, authorities, observation), not just asset identity. */
export function samePolicy(a: AssetPolicySnapshot, b: AssetPolicySnapshot) {
  return stable(a) === stable(b);
}
export interface RewardReview {
  fundingMode: 'SIMULATED';
  legs: {
    label: string;
    policy: AssetPolicySnapshot;
    amount: string;
    decimals: number;
    display: string;
    funded: boolean;
  }[];
  /** ALL_FUNDED only when every leg is covered; a partly covered reward is never eligible for commitment. */
  coverage: 'ALL_FUNDED' | 'PARTIAL' | 'NONE';
  fee: { payer: 'FOUNDER'; amount: '0'; policy: string };
  rent: { applicable: false; payer: null; note: string };
}
/** Every reward leg, who pays fees and rent, and what the host's simulated reserve actually covers. */
export function rewardReview(terms: RaidTerms, catalog: readonly RewardAsset[]): RewardReview {
  const keys = terms.rewards.map((leg) => assetKey(leg.policy.assetId));
  const legs = terms.rewards.map((leg, i) => {
    const asset = catalog.find((entry) => assetKey(entry.policy.assetId) === keys[i]);
    return {
      label: asset?.label ?? 'Unrecognised asset',
      policy: leg.policy,
      amount: leg.amount,
      decimals: leg.policy.verifiedDecimals,
      display: formatDisplayAmount(leg.amount, leg.policy.verifiedDecimals),
      // Covered only for the catalog's exact policy and a single leg per asset; the reservation applies the same rule.
      funded:
        asset?.funded === true &&
        samePolicy(asset.policy, leg.policy) &&
        keys.filter((key) => key === keys[i]).length === 1,
    };
  });
  const funded = legs.filter((leg) => leg.funded).length;
  return {
    fundingMode: 'SIMULATED',
    legs,
    coverage: funded === legs.length && legs.length ? 'ALL_FUNDED' : funded ? 'PARTIAL' : 'NONE',
    fee: { payer: terms.fees.payer, amount: terms.fees.amount, policy: terms.fees.policy },
    rent: {
      applicable: false,
      payer: null,
      note: 'No on-chain account rent exists in this simulated milestone.',
    },
  };
}
/** The only fields a visitor-facing card may carry. Scope, reviewer, policies and funding source never appear. */
export function publicTeaser(terms: RaidTerms) {
  const base = {
    title: terms.title,
    publicSummary: terms.publicSummary,
    category: terms.category,
    difficulty: terms.difficulty,
  };
  if (terms.visibility !== 'PUBLIC') return { kind: 'RESTRICTED' as const, ...base };
  return {
    kind: 'PUBLIC' as const,
    ...base,
    admission: terms.admission,
    execution: terms.execution,
    commitmentDeadline: terms.deadlines.commitment,
    rewards: terms.rewards.map((leg) => ({
      assetId: leg.policy.assetId,
      amount: leg.amount,
    })),
  };
}
