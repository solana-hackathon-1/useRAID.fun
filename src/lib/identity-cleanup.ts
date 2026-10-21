import { db } from './db';
/** Autocommit leaf sweeps: no later root/advisory/child lock and no external side effect. */
export async function sweepIdentityLeaves(
  table: 'Session' | 'OAuthAttempt' | 'WalletChallenge',
  cutoff: Date,
  inclusive = false,
) {
  const pk = table === 'Session' ? 'tokenHash' : table === 'OAuthAttempt' ? 'stateHash' : 'digest';
  let deleted = 0;
  const deadline = Date.now() + 1000;
  for (let batch = 0; batch < 10 && Date.now() < deadline; batch++) {
    const rows = await db.$queryRawUnsafe<{ id: string }[]>(
      `WITH picked AS MATERIALIZED (
      SELECT "${pk}" FROM "${table}" WHERE "expiresAt" ${inclusive ? '<=' : '<'} $1
      ORDER BY "${pk}" LIMIT 100 FOR UPDATE SKIP LOCKED
    ) DELETE FROM "${table}" AS target USING picked WHERE target."${pk}" = picked."${pk}"
      RETURNING target."${pk}" AS "id"`,
      cutoff,
    );
    deleted += rows.length;
    if (rows.length < 100) break;
  }
  return deleted;
}
