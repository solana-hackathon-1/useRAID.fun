import { canonicalRequestDigest } from '../command-receipts';
import { SkillRankSchema } from '../contracts/entities';
import { explainSkillEligibility, type SkillEligibilityInput } from '../skills/eligibility';
import { readPublishedSkillTaxonomy } from '../skills/taxonomy-storage';
import type { AcceptanceHost } from '../work-loop/engagement-contracts';

export interface RootAcceptanceConfig {
  /** The one published skill taxonomy whose stable skill ids Raid terms refer to. */
  taxonomyId: string;
  allowNewWrites: boolean;
  /** Synthetic operator allowlist standing in for Guild authority, which the shared Root cannot recognize yet. */
  isOperator(accountId: string): boolean;
}
export const ROOT_ELIGIBILITY_POLICY = 'root-skill-admission-v1';
interface FactRow {
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
      const consent = await tx.query<{ id: string }>(
        `SELECT c."id"::text FROM "WorkAcceptanceConsent" c JOIN "TermsVersion" t ON t."id"=c."termsVersionId"
         WHERE c."participantId"=$1::uuid AND c."slotId"=$2::uuid AND c."termsVersionId"=$3::uuid AND c."termsDigest"=t."digest"`,
        [ctx.participantId, ctx.slotId, ctx.termsVersionId],
      );
      if (consent.length !== 1) return null;
      try {
        const taxonomy = await readPublishedSkillTaxonomy(tx, ctx.actor, config.taxonomyId);
        if (!taxonomy) return null;
        const skillIds = ctx.terms.requiredSkills.map((s) => s.skillId);
        const facts = await tx.query<FactRow>(
          `SELECT a."id"::text AS "assessmentId",a."revision",v."skillId",v."skillDomain",v."state",v."assessedRank",
            v."policyVersionId"::text AS "policyVersionId",v."evaluatorAccountId",v."issuedAt",v."reassessmentAt",
            v."definitionVersionId"::text AS "definitionVersionId"
           FROM "SkillAssessment" a JOIN "SkillAssessmentVersion" v ON v."id"=a."currentVersionId"
           WHERE a."participantId"=$1::uuid AND a."taxonomyId"=$2 AND a."skillId" IN (SELECT jsonb_array_elements_text($3::jsonb))`,
          [ctx.participantId, config.taxonomyId, JSON.stringify(skillIds)],
        );
        const [clock] = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now', []);
        const now = clock.now;
        const domains = new Map(taxonomy.skills.map((s) => [s.id, s.domain]));
        const context = {
          version: 'v1' as const,
          now: now.toISOString(),
          taxonomy,
          participants: [
            {
              participant: {
                id: ctx.participantId,
                kind: 'HUMAN' as const,
                accountId: ctx.actor.accountId,
              },
              evidence: {
                status: 'CURRENT' as const,
                observedAt: now.toISOString(),
                validUntil: new Date(now.getTime() + 60000).toISOString(),
                skills: facts
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
        const input: SkillEligibilityInput = {
          version: 'v1',
          coverage: 'ONE_MEMBER',
          requirement: {
            kind: 'AND',
            children: ctx.terms.requiredSkills.map((s) => ({
              kind: 'SKILL' as const,
              skillId: s.skillId,
              minimumRank: s.minimumRank,
              verificationRequired: true,
              assessmentPolicyVersion: s.assessmentPolicyVersion,
            })),
          },
        };
        if (explainSkillEligibility(context, input).status !== 'MET') return null;
      } catch {
        // A contract or storage problem is never read as eligibility.
        return null;
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
