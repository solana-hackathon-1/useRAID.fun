import { z } from 'zod';
import { AccountId, InternalId, Revision, UtcTimestamp } from '../contracts/ids';
import { ParticipantSchema, SkillRankSchema, type SkillRank } from '../contracts/entities';
import { PublishedSkillTaxonomySchema } from './contracts';
const Reference = z.strictObject({ recordId: InternalId, revision: Revision });
export const SkillEvidenceFactSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('CLAIM'),
    skillId: InternalId,
    domain: InternalId,
    claimedLevel: z.string().trim().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal('ASSESSMENT'),
    skillId: InternalId,
    domain: InternalId,
    state: z.enum(['UNDER_REVIEW', 'VERIFIED', 'REASSESSMENT_REQUIRED', 'REVOKED']),
    assessedRank: SkillRankSchema,
    assessmentReference: Reference,
    rubricReference: Reference,
    assessmentPolicyVersion: InternalId,
    evaluatorAccountId: AccountId,
    issuedAt: UtcTimestamp,
    reassessmentAt: UtcTimestamp.nullable(),
  }),
]);
const Observation = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('AT_OBSERVATION'),
    observedAt: UtcTimestamp,
    skills: z.array(SkillEvidenceFactSchema).max(1000),
  }),
  z.strictObject({
    status: z.literal('CURRENT'),
    observedAt: UtcTimestamp,
    validUntil: UtcTimestamp,
    skills: z.array(SkillEvidenceFactSchema).max(1000),
  }),
  z.strictObject({ status: z.literal('STALE'), observedAt: UtcTimestamp }),
  z.strictObject({ status: z.literal('UNAVAILABLE') }),
]);
/** Trusted authorized current projections; shape alone proves no reviewer/session authority. */
export const SkillEligibilityContextSchema = z
  .strictObject({
    version: z.literal('v1'),
    now: UtcTimestamp,
    taxonomy: PublishedSkillTaxonomySchema,
    participants: z
      .array(z.strictObject({ participant: ParticipantSchema, evidence: Observation }))
      .min(1)
      .max(50),
  })
  .superRefine((context, ctx) => {
    const now = Date.parse(context.now),
      ids = new Set<string>(),
      accounts = new Set<string>();
    const skills = new Map(context.taxonomy.skills.map((s) => [s.id, s]));
    function invalid(message: string) {
      ctx.addIssue({ code: 'custom', message });
    }
    if (Date.parse(context.taxonomy.publishedAt) > now) invalid('Future taxonomy.');
    for (const { participant, evidence } of context.participants) {
      if (ids.has(participant.id)) invalid('Duplicate participant.');
      ids.add(participant.id);
      if (participant.kind === 'HUMAN') {
        if (accounts.has(participant.accountId)) invalid('Duplicate canonical account.');
        accounts.add(participant.accountId);
      }
      if (evidence.status === 'UNAVAILABLE') continue;
      const observed = Date.parse(evidence.observedAt);
      if (observed > now) invalid('Future observation.');
      if (evidence.status === 'STALE') continue;
      if (evidence.status === 'CURRENT' && Date.parse(evidence.validUntil) < observed)
        invalid('Expiry precedes observation.');
      const current = new Set<string>();
      for (const fact of evidence.skills) {
        if (current.has(fact.skillId)) invalid('Ambiguous current evidence.');
        current.add(fact.skillId);
        const skill = skills.get(fact.skillId);
        if (!skill || skill.domain !== fact.domain)
          invalid('Evidence does not match canonical skill domain.');
        if (fact.kind === 'ASSESSMENT') {
          const issued = Date.parse(fact.issuedAt);
          if (issued > observed) invalid('Assessment is newer than its observation.');
          if (fact.reassessmentAt !== null && Date.parse(fact.reassessmentAt) < issued)
            invalid('Reassessment precedes issuance.');
        }
      }
    }
  });
export type SkillPredicate =
  | {
      kind: 'SKILL';
      skillId: string;
      minimumRank: SkillRank;
      verificationRequired: boolean;
      assessmentPolicyVersion: string;
    }
  | { kind: 'AND' | 'OR'; children: SkillPredicate[] };
/** Parser bounds on a requirement tree: children per AND/OR group, nesting depth and total nodes. */
export const SKILL_PREDICATE_LIMITS = Object.freeze({ children: 16, depth: 8, nodes: 128 });
/** Call the bounded input parser before exposing this recursive schema to untrusted JSON. */
const Predicate: z.ZodType<SkillPredicate> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('SKILL'),
      skillId: InternalId,
      minimumRank: SkillRankSchema,
      verificationRequired: z.boolean(),
      assessmentPolicyVersion: InternalId,
    }),
    z.strictObject({
      kind: z.literal('AND'),
      children: z.array(Predicate).min(1).max(SKILL_PREDICATE_LIMITS.children),
    }),
    z.strictObject({
      kind: z.literal('OR'),
      children: z.array(Predicate).min(1).max(SKILL_PREDICATE_LIMITS.children),
    }),
  ]),
);
const Input = z.strictObject({
  version: z.literal('v1'),
  coverage: z.enum(['ONE_MEMBER', 'DISTRIBUTED_PARTY', 'EVERY_MEMBER']),
  requirement: Predicate.nullable(),
});
export type SkillEligibilityInput = z.infer<typeof Input>;
export type SkillEligibilityContext = z.infer<typeof SkillEligibilityContextSchema>;
export type SkillEligibilityStatus = 'MET' | 'UNMET' | 'UNKNOWN';
export type SkillEligibilityReason =
  | 'VERIFIED_RANK'
  | 'UNVERIFIED_EVIDENCE'
  | 'MISSING_SKILL'
  | 'VERIFICATION_REQUIRED'
  | 'CLAIM_NOT_RANKED'
  | 'RANK_TOO_LOW'
  | 'ASSESSMENT_REVOKED'
  | 'REASSESSMENT_REQUIRED'
  | 'ASSESSMENT_POLICY_CHANGED'
  | 'EVIDENCE_UNAVAILABLE';
export type SkillMemberExplanation = Readonly<{
  participantId: string;
  status: SkillEligibilityStatus;
  reason: SkillEligibilityReason;
  evidenceKind: 'VERIFIED_ASSESSMENT' | 'UNVERIFIED_ASSESSMENT' | 'CLAIM' | null;
  assessedRank: SkillRank | null;
}>;
export type SkillExplanation =
  | Readonly<{ kind: 'NO_REQUIREMENTS'; status: 'MET' }>
  | Readonly<{
      kind: 'SKILL';
      status: SkillEligibilityStatus;
      skillId: string;
      skillDomain: string;
      minimumRank: SkillRank;
      verificationRequired: boolean;
      assessmentPolicyVersion: string;
      members: readonly SkillMemberExplanation[];
    }>
  | Readonly<{
      kind: 'AND' | 'OR';
      status: SkillEligibilityStatus;
      children: readonly SkillExplanation[];
    }>;
export class SkillEligibilityContractError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'INVALID_HOST_CONTRACT') {
    super(code);
    this.name = 'SkillEligibilityContractError';
  }
}
/** Resource limits are parser bounds, not commercial Party-size or admission policy. */
export function parseSkillEligibilityInput(value: unknown): SkillEligibilityInput {
  if (!value || typeof value !== 'object') throw new SkillEligibilityContractError('INVALID_INPUT');
  const node = (value as Record<string, unknown>).requirement;
  if (node !== null) {
    const stack: [unknown, number][] = [[node, 1]],
      seen = new Set<object>();
    let count = 0;
    while (stack.length) {
      const [current, depth] = stack.pop()!;
      if (
        ++count > SKILL_PREDICATE_LIMITS.nodes ||
        depth > SKILL_PREDICATE_LIMITS.depth ||
        !current ||
        typeof current !== 'object' ||
        Array.isArray(current) ||
        seen.has(current)
      )
        throw new SkillEligibilityContractError('INVALID_INPUT');
      seen.add(current);
      const children = (current as Record<string, unknown>).children;
      if (children !== undefined) {
        if (!Array.isArray(children) || children.length > SKILL_PREDICATE_LIMITS.children)
          throw new SkillEligibilityContractError('INVALID_INPUT');
        for (const child of children) stack.push([child, depth + 1]);
      }
    }
  }
  const result = Input.safeParse(value);
  if (!result.success) throw new SkillEligibilityContractError('INVALID_INPUT');
  return result.data;
}
