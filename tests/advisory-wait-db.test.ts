import { afterAll, describe, expect, it } from 'vitest';
import { db } from './helpers/own-assessment-fixture';
import { assertTestDatabase } from './helpers/db-guard';
import { isWaitingOnAdvisoryLock, waitForAdvisoryWaiter } from './helpers/advisory-wait';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const CLASS = 12022;
const lock = (t: Pick<typeof db, '$queryRawUnsafe'>, key: string) =>
  t.$queryRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtextextended($1,$2::bigint))::text',
    key,
    CLASS,
  );

integration('advisory wait observation', () => {
  afterAll(() => db.$disconnect());
  it('matches only a waiter blocked on the exact key, never another advisory waiter', async () => {
    assertTestDatabase();
    const keyA = 'wait-test-a:' + Math.random();
    const keyB = 'wait-test-b:' + Math.random();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const held: (() => void)[] = [];
    const hold = (key: string) =>
      new Promise<Promise<unknown>>((resolve) => {
        const done = db.$transaction(
          async (t) => {
            await lock(t, key);
            resolve(Promise.resolve());
            await released;
          },
          { timeout: 60000 },
        );
        held.push(() => void done);
        void done.catch(() => undefined);
      });
    const waiters: Promise<unknown>[] = [];
    try {
      await hold(keyA);
      await hold(keyB);
      // Another session queues behind keyB only.
      waiters.push(db.$transaction((t) => lock(t, keyB), { timeout: 60000 }));
      expect(await waitForAdvisoryWaiter(db, keyB, CLASS)).toBe(true);
      expect(await isWaitingOnAdvisoryLock(db, keyA, CLASS)).toBe(false);
      expect(await isWaitingOnAdvisoryLock(db, keyB, CLASS + 1)).toBe(false);
    } finally {
      release();
      await Promise.allSettled(waiters);
    }
  });
});
