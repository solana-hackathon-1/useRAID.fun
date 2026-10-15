import { SkillRankSchema } from '../contracts/entities';
import {
  SkillEligibilityContextSchema,
  SkillEligibilityContractError,
  parseSkillEligibilityInput,
  type SkillEligibilityContext,
  type SkillEligibilityStatus,
  type SkillEligibilityReason,
  type SkillPredicate,
  type SkillExplanation,
  type SkillMemberExplanation,
} from './eligibility-contracts';
export * from './eligibility-contracts';
function combine(
  kind: 'AND' | 'OR',
  states: readonly SkillEligibilityStatus[],
): SkillEligibilityStatus {
  if (kind === 'AND')
    return states.includes('UNMET') ? 'UNMET' : states.includes('UNKNOWN') ? 'UNKNOWN' : 'MET';
  return states.includes('MET') ? 'MET' : states.includes('UNKNOWN') ? 'UNKNOWN' : 'UNMET';
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Pure private informational explanation. Acceptance must re-read and authorize its own current facts. */
export function explainSkillEligibility(contextValue: unknown, inputValue: unknown) {
  const parsed = SkillEligibilityContextSchema.safeParse(contextValue);
  if (!parsed.success) throw new SkillEligibilityContractError('INVALID_HOST_CONTRACT');
  const context = parsed.data,
    input = parseSkillEligibilityInput(inputValue),
    now = Date.parse(context.now);
  const catalog = new Map(context.taxonomy.skills.map((skill) => [skill.id, skill]));
  function validate(node: SkillPredicate | null): void {
    if (node === null) return;
    if (node.kind === 'SKILL') {
      if (!catalog.has(node.skillId)) throw new SkillEligibilityContractError('INVALID_INPUT');
    } else for (const child of node.children) validate(child);
  }
  validate(input.requirement);
  function explainMember(
    subject: SkillEligibilityContext['participants'][number],
    predicate: Extract<SkillPredicate, { kind: 'SKILL' }>,
  ): SkillMemberExplanation {
    const evidence = subject.evidence;
    const result = (
      status: SkillEligibilityStatus,
      reason: SkillEligibilityReason,
      evidenceKind: SkillMemberExplanation['evidenceKind'] = null,
      assessedRank: SkillMemberExplanation['assessedRank'] = null,
    ) => ({ participantId: subject.participant.id, status, reason, evidenceKind, assessedRank });
    if (
      evidence.status === 'UNAVAILABLE' ||
      evidence.status === 'STALE' ||
      (evidence.status === 'CURRENT' && Date.parse(evidence.validUntil) <= now) ||
      (evidence.status === 'AT_OBSERVATION' && Date.parse(evidence.observedAt) !== now)
    )
      return result('UNKNOWN', 'EVIDENCE_UNAVAILABLE');
    const fact = evidence.skills.find((s) => s.skillId === predicate.skillId);
    if (!fact) return result('UNMET', 'MISSING_SKILL');
    if (fact.kind === 'CLAIM')
      return predicate.verificationRequired
        ? result('UNMET', 'VERIFICATION_REQUIRED', 'CLAIM')
        : result('UNKNOWN', 'CLAIM_NOT_RANKED', 'CLAIM');
    // Denied/obsolete evidence supplies no claimed qualifying rank, even for weaker predicates.
    if (fact.state === 'REVOKED') return result('UNMET', 'ASSESSMENT_REVOKED');
    if (
      fact.state === 'REASSESSMENT_REQUIRED' ||
      (fact.reassessmentAt !== null && Date.parse(fact.reassessmentAt) <= now)
    )
      return result('UNMET', 'REASSESSMENT_REQUIRED');
    if (fact.assessmentPolicyVersion !== predicate.assessmentPolicyVersion)
      return result('UNMET', 'ASSESSMENT_POLICY_CHANGED');
    const kind = fact.state === 'VERIFIED' ? 'VERIFIED_ASSESSMENT' : 'UNVERIFIED_ASSESSMENT';
    if (fact.state !== 'VERIFIED' && predicate.verificationRequired)
      return result('UNMET', 'VERIFICATION_REQUIRED', kind);
    if (
      SkillRankSchema.options.indexOf(fact.assessedRank) <
      SkillRankSchema.options.indexOf(predicate.minimumRank)
    )
      return result('UNMET', 'RANK_TOO_LOW', kind, fact.assessedRank);
    return result(
      'MET',
      fact.state === 'VERIFIED' ? 'VERIFIED_RANK' : 'UNVERIFIED_EVIDENCE',
      kind,
      fact.assessedRank,
    );
  }
  function evaluate(
    node: SkillPredicate | null,
    subjects: SkillEligibilityContext['participants'],
  ): SkillExplanation {
    if (node === null) return { kind: 'NO_REQUIREMENTS', status: 'MET' };
    if (node.kind === 'SKILL') {
      const members = subjects.map((s) => explainMember(s, node));
      return {
        ...node,
        skillDomain: catalog.get(node.skillId)!.domain,
        status: combine(
          'OR',
          members.map((s) => s.status),
        ),
        members,
      };
    }
    const children = node.children.map((child) => evaluate(child, subjects));
    return {
      kind: node.kind,
      status: combine(
        node.kind,
        children.map((child) => child.status),
      ),
      children,
    };
  }
  const groups =
    input.coverage === 'DISTRIBUTED_PARTY'
      ? [context.participants]
      : context.participants.map((p) => [p]);
  const evaluations = groups.map((subjects) => ({
    participantIds: subjects.map((s) => s.participant.id),
    explanation: evaluate(input.requirement, subjects),
  }));
  return freeze({
    version: 'v1' as const,
    status: combine(
      input.coverage === 'EVERY_MEMBER' ? 'AND' : 'OR',
      evaluations.map((e) => e.explanation.status),
    ),
    coverage: input.coverage,
    evaluatedAt: new Date(context.now).toISOString(),
    taxonomyReference: { recordId: context.taxonomy.id, revision: context.taxonomy.revision },
    evaluations,
    informational: true as const,
    isAuthorizationToken: false as const,
    verifiesSkill: false as const,
    createsPermissionGrant: false as const,
    consumesCapacity: false as const,
    persisted: false as const,
  });
}
