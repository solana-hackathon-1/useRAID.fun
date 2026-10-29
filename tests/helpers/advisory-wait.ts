type RawClient = { $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown> };

/**
 * True when some session is blocked on the advisory lock for exactly this key and class, i.e. the
 * `pg_advisory_xact_lock(hashtextextended(key, class))` bigint key, split by Postgres into classid/objid.
 */
export async function isWaitingOnAdvisoryLock(db: RawClient, key: string, classId: number) {
  const rows = (await db.$queryRawUnsafe(
    `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objsubid=1 AND NOT granted
       AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1,$2::bigint)`,
    key,
    classId,
  )) as unknown[];
  return rows.length > 0;
}

/** Polls the database state (not a clock) until a waiter on this exact key appears. */
export async function waitForAdvisoryWaiter(
  db: RawClient,
  key: string,
  classId: number,
  attempts = 100,
) {
  for (let i = 0; i < attempts; i++) {
    if (await isWaitingOnAdvisoryLock(db, key, classId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
