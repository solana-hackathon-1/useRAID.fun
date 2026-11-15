import type { OverdueSkillAssessmentAppeal } from './contracts';

/**
 * Operator alert for overdue skill-assessment appeals (DEC-2026-11-13-12 (b)): an appeal past its adjudication target
 * stays pending and raises an alert, never an automatic outcome. This module only shapes and rate-limits the alert; it
 * reads through an injected `list` (the caller supplies the transaction), writes nothing and decides nothing. Host
 * contract: a bounded read of overdue appeals, a line sink, and a clock; no environment, database or logger import.
 */
export const OVERDUE_ALERT_NAME = 'skill-appeal-overdue';
/** One alert per process at most this often while the same backlog stays overdue (the worker runs about once a minute). */
export const OVERDUE_ALERT_REPEAT_SECONDS = 15 * 60;
/** Appeal ids named in one alert; the count says how many more there are. */
export const OVERDUE_ALERT_MAX_IDS = 10;
/** The bounded read; a full read is reported as "at least". */
export const OVERDUE_ALERT_READ_LIMIT = 100;

/** Ids, counts and ages only: never an account, a statement, an evaluator or an outcome. */
export interface OverdueAppealAlert {
  readonly alert: typeof OVERDUE_ALERT_NAME;
  readonly count: number;
  readonly atLeast: boolean;
  readonly oldestOverdueSeconds: number;
  readonly appealIds: readonly string[];
}

/** `overdue` is oldest first (the order `listOverdueSkillAssessmentAppeals` returns). */
export function buildOverdueAppealAlert(
  overdue: readonly OverdueSkillAssessmentAppeal[],
  limit: number,
): OverdueAppealAlert | null {
  if (overdue.length === 0) return null;
  return Object.freeze({
    alert: OVERDUE_ALERT_NAME,
    count: overdue.length,
    atLeast: overdue.length >= limit,
    oldestOverdueSeconds: overdue[0].overdueSeconds,
    appealIds: Object.freeze(overdue.slice(0, OVERDUE_ALERT_MAX_IDS).map((r) => r.appealId)),
  });
}

export interface OverdueAppealAlerterPorts {
  readonly list: (limit: number) => Promise<readonly OverdueSkillAssessmentAppeal[]>;
  readonly log: (line: OverdueAppealAlert) => void;
  /** Epoch milliseconds. */
  readonly now: () => number;
}

/**
 * One alert pass. Returns the alert it logged, or null when nothing is overdue or the previous alert is still inside
 * the repeat interval. A failed read propagates so the caller's step records the failure.
 */
export function createOverdueAppealAlerter(ports: OverdueAppealAlerterPorts) {
  let lastAlertAt: number | null = null;
  return async (): Promise<OverdueAppealAlert | null> => {
    const alert = buildOverdueAppealAlert(
      await ports.list(OVERDUE_ALERT_READ_LIMIT),
      OVERDUE_ALERT_READ_LIMIT,
    );
    if (!alert) return null;
    const at = ports.now();
    if (lastAlertAt !== null && at - lastAlertAt < OVERDUE_ALERT_REPEAT_SECONDS * 1000) return null;
    lastAlertAt = at;
    ports.log(alert);
    return alert;
  };
}
