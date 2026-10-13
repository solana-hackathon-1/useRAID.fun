import { expect, it } from 'vitest';
import { matchesBlockingObservation } from './helpers/lock-observation';
it('waits for the required statement after a blocking PID becomes visible during activity refresh', () => {
  const samples = [
    { query: 'SHOW transaction_isolation', blockers: [101] },
    { query: 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', blockers: [101] },
  ];
  expect(
    samples.filter((row) => matchesBlockingObservation(row, 101, /pg_advisory_xact_lock/)),
  ).toEqual([samples[1]]);
});
it('does not accept the right statement without the actual expected blocking relationship', () => {
  expect(
    matchesBlockingObservation(
      { query: 'SELECT pg_advisory_xact_lock(1)', blockers: [202] },
      101,
      /pg_advisory_xact_lock/,
    ),
  ).toBe(false);
  expect(matchesBlockingObservation(undefined, 101, /pg_advisory_xact_lock/)).toBe(false);
});
