import {
  adjudicateSkillAssessmentAppeal,
  DEFAULT_APPEAL_ADJUDICATION_SECONDS,
  DEFAULT_APPEAL_FILING_WINDOW_SECONDS,
  fileSkillAssessmentAppeal,
  type SkillAppealCommand,
} from '../skill-appeals/storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';

/**
 * Exact-string flag, default off. It gates only NEW filings and decisions: an original receipt still replays. Appeals
 * move no money and grant no rank, so no real-funds switch is consulted.
 */
export function skillAppealConfiguration() {
  const writesAvailable = process.env.SKILL_ASSESSMENT_APPEALS_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
/**
 * The dedicated adjudicator allowlist (`SKILL_APPEAL_REVIEWER_ACCOUNT_IDS`, comma-separated account ids, exact match).
 * It is separate from every other operator list. Unset or empty denies everyone. Read on every call so a removal takes
 * effect at once. Being listed is necessary, never sufficient: the storage still refuses the appellant, any original
 * reviewer and anyone related to the appellant through a Guild.
 */
export function skillAppealAdjudicators() {
  return new Set(
    (process.env.SKILL_APPEAL_REVIEWER_ACCOUNT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
// PROVISIONAL (DEC-2026-11-14-11): 14 days each, owner may revisit. Malformed values fall back to the default, never to
// "unlimited" or "zero".
function days(name: string, fallbackSeconds: number) {
  const raw = process.env[name]?.trim();
  if (!raw || !/^[0-9]{1,3}$/.test(raw)) return fallbackSeconds;
  const value = Number(raw);
  return value >= 1 && value <= 365 ? value * 86400 : fallbackSeconds;
}
export function skillAppealWindows() {
  return {
    filingWindowSeconds: days(
      'SKILL_APPEAL_FILING_WINDOW_DAYS',
      DEFAULT_APPEAL_FILING_WINDOW_SECONDS,
    ),
    adjudicationSeconds: days(
      'SKILL_APPEAL_ADJUDICATION_DAYS',
      DEFAULT_APPEAL_ADJUDICATION_SECONDS,
    ),
  };
}

export const fileSkillAppealFromHost = (command: SkillAppealCommand) =>
  runCommandTransaction(db, (tx) =>
    fileSkillAssessmentAppeal(tx, command, {
      allowNewWrites: skillAppealConfiguration().writesAvailable,
      ...skillAppealWindows(),
    }),
  );
export const adjudicateSkillAppealFromHost = (command: SkillAppealCommand) =>
  runCommandTransaction(db, (tx) =>
    adjudicateSkillAssessmentAppeal(tx, command, {
      allowNewWrites: skillAppealConfiguration().writesAvailable,
      isAdjudicator: (accountId) => skillAppealAdjudicators().has(accountId),
    }),
  );
