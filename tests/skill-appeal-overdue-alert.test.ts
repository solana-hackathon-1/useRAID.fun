import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  OVERDUE_ALERT_MAX_IDS,
  OVERDUE_ALERT_REPEAT_SECONDS,
  buildOverdueAppealAlert,
  createOverdueAppealAlerter,
} from '../src/skill-appeals/overdue-alert';

const overdue = (n: number, seconds = 30) =>
  Array.from({ length: n }, (_, i) => ({
    appealId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    adjudicationDueAt: '2026-11-01T00:00:00.000Z',
    overdueSeconds: seconds - i,
  }));

describe('overdue skill-assessment appeal operator alert (DEC-2026-11-13-12 (b))', () => {
  it('raises nothing when no appeal is overdue', () => {
    expect(buildOverdueAppealAlert([], 100)).toBeNull();
  });
  it('is value-free: a stable name, a count, the oldest overdue age and capped appeal ids only', () => {
    const alert = buildOverdueAppealAlert(overdue(15), 100);
    expect(alert).toEqual({
      alert: 'skill-appeal-overdue',
      count: 15,
      atLeast: false,
      oldestOverdueSeconds: 30,
      appealIds: overdue(15)
        .slice(0, OVERDUE_ALERT_MAX_IDS)
        .map((r) => r.appealId),
    });
  });
  it('says "at least" when the bounded read was full', () => {
    expect(buildOverdueAppealAlert(overdue(3), 3)).toMatchObject({ count: 3, atLeast: true });
  });
  it('logs once, repeats no sooner than the interval, and never decides an appeal', async () => {
    const lines: unknown[] = [];
    let clock = 1_000_000;
    const alerter = createOverdueAppealAlerter({
      list: async () => overdue(2),
      log: (line) => lines.push(line),
      now: () => clock,
    });
    expect(await alerter()).toMatchObject({ alert: 'skill-appeal-overdue', count: 2 });
    clock += (OVERDUE_ALERT_REPEAT_SECONDS - 1) * 1000;
    expect(await alerter()).toBeNull();
    expect(lines).toHaveLength(1);
    clock += 1000;
    expect(await alerter()).toMatchObject({ count: 2 });
    expect(lines).toHaveLength(2);
  });
  it('alerts again inside the interval when the overdue set gains a new appeal, naming it', async () => {
    let rows = overdue(2);
    let clock = 1_000_000;
    const lines: unknown[] = [];
    const alerter = createOverdueAppealAlerter({
      list: async () => rows,
      log: (line) => lines.push(line),
      now: () => clock,
    });
    expect(await alerter()).toMatchObject({ count: 2 });
    clock += 1000;
    expect(await alerter()).toBeNull();
    rows = overdue(3);
    clock += 1000;
    expect(await alerter()).toMatchObject({ count: 3 });
    expect(lines).toHaveLength(2);
    // The new set is now the baseline: the same three stay quiet until the interval passes.
    clock += 1000;
    expect(await alerter()).toBeNull();
    // A shrinking set (an appeal was decided) is not new information and stays quiet inside the interval.
    rows = overdue(2);
    clock += 1000;
    expect(await alerter()).toBeNull();
  });
  it('treats a fully cleared backlog as a fresh start for the next overdue appeal', async () => {
    let rows = overdue(1);
    let clock = 1_000_000;
    const alerter = createOverdueAppealAlerter({
      list: async () => rows,
      log: () => undefined,
      now: () => clock,
    });
    expect(await alerter()).toMatchObject({ count: 1 });
    rows = [];
    clock += 1000;
    expect(await alerter()).toBeNull();
    rows = overdue(1);
    clock += 1000;
    expect(await alerter()).toMatchObject({ count: 1 });
  });
  it('does not consume the repeat interval when nothing was overdue', async () => {
    let rows = overdue(0);
    const alerter = createOverdueAppealAlerter({
      list: async () => rows,
      log: () => undefined,
      now: () => 5,
    });
    expect(await alerter()).toBeNull();
    rows = overdue(1);
    expect(await alerter()).toMatchObject({ count: 1 });
  });
  it('lets a failed read propagate so the worker step records the failure', async () => {
    const alerter = createOverdueAppealAlerter({
      list: async () => {
        throw new Error('STORAGE_UNAVAILABLE');
      },
      log: () => undefined,
      now: () => 0,
    });
    await expect(alerter()).rejects.toThrow('STORAGE_UNAVAILABLE');
  });
});
describe('worker wiring', () => {
  it('runs the alert as its own named schedule step', async () => {
    const jobs = await readFile('src/lib/worker-jobs.ts', 'utf8');
    expect(jobs).toMatch(
      /step\('skill-appeal-overdue',\s*\(\)\s*=>\s*runSkillAppealOverdueAlert\(\)\)/,
    );
    const health = await readFile('src/lib/worker-health.ts', 'utf8');
    expect(health).toContain("'skill-appeal-overdue'");
  });
  it('keeps the alert module free of host imports so a replacement host can consume it', async () => {
    const source = await readFile('src/skill-appeals/overdue-alert.ts', 'utf8');
    expect(source).not.toMatch(/from ['"][^'"]*\/lib\//);
    expect(source).not.toMatch(/process\.env|console\./);
  });
});
