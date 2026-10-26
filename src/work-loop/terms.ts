import { z } from 'zod';
import { InternalId, UtcTimestamp } from '../contracts/ids';
import { SkillRankSchema } from '../contracts/entities';
import { AmountSchema, AssetPolicySnapshotSchema } from '../contracts/assets';
import { fromJsonAmount } from '../asset-registry/amounts';

const text = z.string().trim().min(1).max(8000);
const list = z.array(text).min(1).max(50);
const units = AmountSchema.refine((value) => {
  try {
    return fromJsonAmount(value) > 0n;
  } catch {
    return false;
  }
}, 'A positive bounded base-unit amount is required.');
/** Prospective listing terms. Accepted TermsSnapshot additionally binds roster/beneficiaries. */
export const RaidTermsSchema = z
  .strictObject({
    version: z.literal('v1'),
    title: text.max(200),
    publicSummary: text.max(1000),
    category: InternalId,
    outcome: text,
    deliverables: list,
    acceptanceCriteria: list,
    exclusions: z.array(text).max(50),
    dependencies: z.array(text).max(50),
    difficulty: SkillRankSchema,
    requiredSkills: z
      .array(
        z.strictObject({
          skillId: InternalId,
          minimumRank: SkillRankSchema,
          assessmentPolicyVersion: InternalId,
        }),
      )
      .min(1)
      .max(50),
    participantKinds: z
      .array(z.enum(['HUMAN', 'AI_AGENT', 'AI_INFLUENCER']))
      .min(1)
      .max(3),
    execution: z.enum(['SOLO', 'PARTY']),
    admission: z.enum(['INSTANT', 'APPLICATION']),
    visibility: z.enum(['PUBLIC', 'TRUSTED_LISTING', 'CONFIDENTIAL_LISTING', 'INVITE_ONLY']),
    allowedToolsPolicy: text,
    deadlines: z.strictObject({
      commitment: UtcTimestamp,
      preparation: UtcTimestamp,
      submission: UtcTimestamp,
      review: UtcTimestamp,
      operationalClosure: UtcTimestamp,
    }),
    startCondition: text,
    review: z.strictObject({
      reviewerAccountId: InternalId,
      evidence: text,
      maxRevisionRounds: z.number().int().min(0).max(10),
    }),
    rightsPolicy: text,
    portfolioPolicy: text,
    withdrawalPolicy: text,
    terminationPolicy: text,
    disputePolicy: text,
    finalityPolicy: text,
    rewards: z
      .array(z.strictObject({ policy: AssetPolicySnapshotSchema, amount: units }))
      .min(1)
      .max(10),
    fees: z.strictObject({ payer: z.literal('FOUNDER'), amount: z.literal('0'), policy: text }),
    fundingSourceRef: InternalId,
    // This milestone supplies simulation only. No provider, custody or fee policy is selected.
    settlementMechanism: z.literal('SIMULATED'),
  })
  .superRefine((terms, ctx) => {
    const deadlines = Object.values(terms.deadlines).map(Date.parse);
    if (deadlines.some((time, i) => i > 0 && time <= deadlines[i - 1]))
      ctx.addIssue({
        code: 'custom',
        path: ['deadlines'],
        message: 'Deadlines must be finite and strictly ordered.',
      });
    if (new Set(terms.requiredSkills.map((s) => s.skillId)).size !== terms.requiredSkills.length)
      ctx.addIssue({ code: 'custom', path: ['requiredSkills'], message: 'Duplicate skill.' });
    if (new Set(terms.participantKinds).size !== terms.participantKinds.length)
      ctx.addIssue({
        code: 'custom',
        path: ['participantKinds'],
        message: 'Duplicate participant kind.',
      });
  })
  .readonly();
export type RaidTerms = z.infer<typeof RaidTermsSchema>;
export function publicationProblems(input: unknown, now: Date): string[] {
  const parsed = RaidTermsSchema.safeParse(input);
  if (!parsed.success || !Number.isFinite(now.getTime())) return ['INVALID_TERMS'];
  const terms = parsed.data,
    problems: string[] = [];
  if (Date.parse(terms.deadlines.commitment) <= now.getTime()) problems.push('DEADLINE_PASSED');
  if (
    (['B', 'A', 'S'].includes(terms.difficulty) || terms.visibility !== 'PUBLIC') &&
    terms.admission !== 'APPLICATION'
  )
    problems.push('APPROVAL_REQUIRED');
  if (
    terms.visibility !== 'PUBLIC' ||
    terms.execution !== 'SOLO' ||
    terms.participantKinds.some((kind) => kind !== 'HUMAN')
  )
    problems.push('UNSUPPORTED_MODE');
  return problems;
}
