import {
  CommandReceiptError,
  canonicalRequestDigest,
  type CommandReceiptTransaction,
  type SqlBinding,
} from '../command-receipts';
import { SkillRankSchema, type SkillRank } from '../contracts/entities';
import {
  SKILL_PREDICATE_LIMITS,
  SkillEligibilityContractError,
  explainSkillEligibility,
  type SkillEligibilityContext,
  type SkillEligibilityInput,
  type SkillPredicate,
} from '../skills/eligibility';
import { SkillTaxonomyStorageError } from '../skills/taxonomy-storage-contracts';
import { readPublishedSkillTaxonomy } from '../skills/taxonomy-storage';
import { WorkError } from '../work-loop/contracts';
import type { AcceptanceHost } from '../work-loop/engagement-contracts';

export interface RootAcceptanceConfig {
  /** The one published skill taxonomy whose stable skill ids Raid terms refer to. */
  taxonomyId: string;
  allowNewWrites: boolean;
  /** Synthetic operator allowlist standing in for Guild authority, which the shared Root cannot recognize yet. */
  isOperator(accountId: string): boolean;
}
/**
 * Only a request the reader rejects as invalid or not permitted is a verdict on the person. A missing or restricted
 * session is the caller's session problem and is reported as such; anything else is an outage.
 */
const NOT_APPROVED = new Set<string>(['INVALID_INPUT', 'FORBIDDEN']);
const SESSION_PROBLEM: Readonly<Record<string, 'UNAUTHENTICATED' | 'ACCOUNT_RESTRICTED'>> = {
  AUTHENTICATION_REQUIRED: 'UNAUTHENTICATED',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
};
/** A storage failure while reading the person's facts: not a verdict, safe to retry. */
export class RootAcceptanceUnavailableError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE' as const;
  readonly retryable = true as const;
  constructor() {
    super('STORAGE_UNAVAILABLE');
    this.name = 'RootAcceptanceUnavailableError';
  }
}
type Tx = Parameters<AcceptanceHost['assess']>[0];
/**
 * Deadlock/serialization signals pass through so the whole transaction is retried. The production port's own storage
 * outage is the same retryable outage as any other driver failure, so it is typed here too.
 */
async function available<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CommandReceiptError && error.code !== 'STORAGE_UNAVAILABLE') throw error;
    throw new RootAcceptanceUnavailableError();
  }
}
const read = <Row>(tx: Tx, sql: string, bindings: readonly SqlBinding[]) =>
  available(() => (tx as CommandReceiptTransaction).query<Row>(sql, bindings));
/**
 * Every required skill must be met. Groups respect the eligibility parser's per-group child limit; terms allow up
 * to 50 skills, which fits two levels well inside its depth and node bounds. No skills is not a requirement.
 */
export function buildSkillRequirement(
  required: readonly { skillId: string; minimumRank: SkillRank; assessmentPolicyVersion: string }[],
): SkillPredicate {
  if (required.length === 0) throw new SkillEligibilityContractError('INVALID_INPUT');
  const leaves: SkillPredicate[] = required.map((s) => ({
    kind: 'SKILL',
    skillId: s.skillId,
    minimumRank: s.minimumRank,
    verificationRequired: true,
    assessmentPolicyVersion: s.assessmentPolicyVersion,
  }));
  let level = leaves;
  do {
    const groups: SkillPredicate[] = [];
    for (let i = 0; i < level.length; i += SKILL_PREDICATE_LIMITS.children)
      groups.push({ kind: 'AND', children: level.slice(i, i + SKILL_PREDICATE_LIMITS.children) });
    level = groups;
  } while (level.length > 1);
  return level[0];
}
/**
 * Decisions (revoke, reassess, verify) take this per-person, per-skill lock until they commit. Holding it to our commit
 * means the evidence read cannot go stale before the engagement is inserted. Sorted and unique, so concurrent
 * acceptances take the locks in one order.
 */
async function lockAssessmentEvidence(
  tx: Parameters<AcceptanceHost['assess']>[0],
  participantId: string,
  skillIds: readonly string[],
) {
  for (const skillId of [...new Set(skillIds)].sort())
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,12022))::text', [
      participantId + ':' + skillId,
    ]);
}
export const ROOT_ELIGIBILITY_POLICY = 'root-skill-admission-v1';
export interface FactRow {
  assessmentId: string;
  revision: number;
  skillId: string;
  skillDomain: string;
  state: 'UNDER_REVIEW' | 'VERIFIED' | 'REASSESSMENT_REQUIRED' | 'REVOKED';
  assessedRank: (typeof SkillRankSchema.options)[number];
  policyVersionId: string;
  evaluatorAccountId: string;
  issuedAt: Date;
  reassessmentAt: Date | null;
  definitionVersionId: string;
}
/** The eligibility context for one person from their current assessment facts, observed at database time. */
export function buildRootEligibilityContext(source: {
  participantId: string;
  accountId: string;
  taxonomy: SkillEligibilityContext['taxonomy'];
  facts: readonly FactRow[];
  now: Date;
}) {
  const { now, taxonomy } = source;
  const domains = new Map(taxonomy.skills.map((s) => [s.id, s.domain]));
  return {
    version: 'v1' as const,
    now: now.toISOString(),
    taxonomy,
    participants: [
      {
        participant: {
          id: source.participantId,
          kind: 'HUMAN' as const,
          accountId: source.accountId,
        },
        evidence: {
          status: 'CURRENT' as const,
          observedAt: now.toISOString(),
          validUntil: new Date(now.getTime() + 60000).toISOString(),
          skills: source.facts
            // Evidence whose domain no longer matches the published taxonomy supplies nothing.
            .filter((f) => domains.get(f.skillId) === f.skillDomain)
            .map((f) => ({
              kind: 'ASSESSMENT' as const,
              skillId: f.skillId,
              domain: f.skillDomain,
              state: f.state,
              assessedRank: f.assessedRank,
              assessmentReference: { recordId: f.assessmentId, revision: f.revision },
              rubricReference: { recordId: f.definitionVersionId, revision: 1 },
              assessmentPolicyVersion: f.policyVersionId,
              evaluatorAccountId: f.evaluatorAccountId,
              issuedAt: f.issuedAt.toISOString(),
              reassessmentAt: f.reassessmentAt ? f.reassessmentAt.toISOString() : null,
            })),
        },
      },
    ],
  };
}
/**
 * Acceptance host for the shared Root. A person is approved only with (1) their own recorded consent to the exact
 * stored terms and (2) a current VERIFIED assessment meeting every required skill under the terms' assessment policy.
 * Claims, unverified or revoked evidence, a missing taxonomy or any evaluation problem fail closed. The simulated
 * reservation is the funding binding; beneficiary is a placeholder until payout destinations exist.
 */
export function createRootAcceptanceHost(config: RootAcceptanceConfig): AcceptanceHost {
  return {
    allowNewWrites: config.allowNewWrites,
    async assess(tx, ctx) {
      const consent = await read<{ id: string }>(
        tx,
        `SELECT c."id"::text FROM "WorkAcceptanceConsent" c JOIN "TermsVersion" t ON t."id"=c."termsVersionId"
         WHERE c."participantId"=$1::uuid AND c."slotId"=$2::uuid AND c."termsVersionId"=$3::uuid AND c."termsDigest"=t."digest"`,
        [ctx.participantId, ctx.slotId, ctx.termsVersionId],
      );
      // Tell the person what to do next; it is about their own consent only and reveals nothing about others.
      if (consent.length !== 1) throw new WorkError('CONSENT_REQUIRED');
      let taxonomy;
      try {
        taxonomy = await readPublishedSkillTaxonomy(tx, ctx.actor, config.taxonomyId);
      } catch (error) {
        if (error instanceof SkillTaxonomyStorageError) {
          // An unreadable or unpublished taxonomy means no one can be approved.
          if (NOT_APPROVED.has(error.code)) return null;
          const session = SESSION_PROBLEM[error.code];
          if (session) throw new WorkError(session);
        }
        // An outage is not a verdict on the person.
        throw error;
      }
      if (!taxonomy) return null;
      // Terms that name no skill have no verified-skill basis for admission at the Root; refuse rather than build
      // an empty requirement.
      if (ctx.terms.requiredSkills.length === 0) return null;
      const skillIds = ctx.terms.requiredSkills.map((s) => s.skillId);
      await available(() => lockAssessmentEvidence(tx, ctx.participantId, skillIds));
      const facts = await read<FactRow>(
        tx,
        `SELECT a."id"::text AS "assessmentId",a."revision",v."skillId",v."skillDomain",v."state",v."assessedRank",
          v."policyVersionId"::text AS "policyVersionId",v."evaluatorAccountId",v."issuedAt",v."reassessmentAt",
          v."definitionVersionId"::text AS "definitionVersionId"
         FROM "SkillAssessment" a JOIN "SkillAssessmentVersion" v ON v."id"=a."currentVersionId"
         WHERE a."participantId"=$1::uuid AND a."taxonomyId"=$2 AND a."skillId" IN (SELECT jsonb_array_elements_text($3::jsonb))`,
        [ctx.participantId, config.taxonomyId, JSON.stringify(skillIds)],
      );
      const [clock] = await read<{ now: Date }>(tx, 'SELECT clock_timestamp() AS now', []);
      if (!(clock?.now instanceof Date)) throw new RootAcceptanceUnavailableError();
      const context = buildRootEligibilityContext({
        participantId: ctx.participantId,
        accountId: ctx.actor.accountId,
        taxonomy,
        facts,
        now: clock.now,
      });
      const input: SkillEligibilityInput = {
        version: 'v1',
        coverage: 'ONE_MEMBER',
        requirement: buildSkillRequirement(ctx.terms.requiredSkills),
      };
      try {
        if (explainSkillEligibility(context, input).status !== 'MET') return null;
      } catch (error) {
        // Only a requirement the person's terms cannot satisfy is a verdict. A malformed host contract (a bad stored
        // row or a Root bug) surfaces to operators instead of silently rejecting every applicant.
        if (error instanceof SkillEligibilityContractError && error.code === 'INVALID_INPUT')
          return null;
        throw error;
      }
      return {
        consentRef: consent[0].id,
        beneficiaryRef: 'simulated-beneficiary:' + ctx.participantId,
        eligibilityPolicyVersion: ROOT_ELIGIBILITY_POLICY,
        operatorId: null,
      };
    },
    async fundingAvailable(tx, binding) {
      const rows = await tx.query(
        'SELECT 1 FROM "WorkSimulatedReservation" WHERE "slotId"=$1::uuid AND "termsVersionId"=$2::uuid AND "fundingRef"=$3 AND "vectorDigest"=$4',
        [
          binding.slotId,
          binding.termsVersionId,
          binding.fundingRef,
          canonicalRequestDigest(binding.terms.rewards),
        ],
      );
      return rows.length === 1;
    },
    async authorizeOfferIssuer(_tx, issuer) {
      return config.isOperator(issuer.accountId);
    },
  };
}
