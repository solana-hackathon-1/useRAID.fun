import { z } from 'zod';

/**
 * Skill-assessment appeal windows (blueprint 09.7, DEC-2026-11-13-12 / DEC-2026-11-14-11). Both are PROVISIONAL: the
 * owner may revisit them, so a host passes its own values (the Next host reads
 * `SKILL_APPEAL_FILING_WINDOW_DAYS` / `SKILL_APPEAL_ADJUDICATION_DAYS`) and these are only the decided defaults.
 */
export const DEFAULT_APPEAL_FILING_WINDOW_SECONDS = 14 * 86400;
export const DEFAULT_APPEAL_ADJUDICATION_SECONDS = 14 * 86400;

const Id = z.string().min(1).max(200);
export const AppealAdjudicatorFactsSchema = z
  .strictObject({
    version: z.literal('v1'),
    adjudicatorAccountId: Id,
    appellantAccountId: Id,
    /** Every evaluator who issued, reviewed or decided any version of the appealed assessment. */
    originalReviewerAccountIds: z.array(Id).max(1000).readonly(),
    /** Guilds where the adjudicator and the appellant each hold a Founder or live role relationship. */
    sharedGuildIds: z.array(Id).max(1000).readonly(),
    /** The host's current dedicated allowlist answer for the adjudicator. */
    onAllowlist: z.boolean(),
  })
  .readonly();
export type AppealAdjudicatorFacts = z.input<typeof AppealAdjudicatorFactsSchema>;
export type AppealAdjudicatorVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        'SELF_ADJUDICATION' | 'ORIGINAL_REVIEWER' | 'GUILD_RELATIONSHIP' | 'NOT_AUTHORIZED';
    };

/**
 * Pure independence rule: an adjudicator is the appellant, an original reviewer or related to the appellant through a
 * Guild never; otherwise only the dedicated allowlist authorizes. Self-adjudication is reported first so the most
 * specific refusal wins. The answer is informational and never a token a caller can hand back. Related-Party and
 * financial-interest conflicts (17.4) are not observable for skill assessments yet and stay a recorded gap.
 */
export function evaluateAppealAdjudicator(value: AppealAdjudicatorFacts): AppealAdjudicatorVerdict {
  const facts = AppealAdjudicatorFactsSchema.parse(value);
  if (facts.adjudicatorAccountId === facts.appellantAccountId)
    return { allowed: false, reason: 'SELF_ADJUDICATION' };
  if (facts.originalReviewerAccountIds.includes(facts.adjudicatorAccountId))
    return { allowed: false, reason: 'ORIGINAL_REVIEWER' };
  if (facts.sharedGuildIds.length > 0) return { allowed: false, reason: 'GUILD_RELATIONSHIP' };
  if (!facts.onAllowlist) return { allowed: false, reason: 'NOT_AUTHORIZED' };
  return { allowed: true };
}

/** An appeal may be filed through the instant the window ends (inclusive) and never before the decision. */
export function appealFilingWindowOpen(
  decidedAt: string,
  now: string,
  windowSeconds: number,
): boolean {
  const start = Date.parse(decidedAt),
    at = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(at) || !(windowSeconds > 0)) return false;
  return at >= start && at <= start + windowSeconds * 1000;
}
