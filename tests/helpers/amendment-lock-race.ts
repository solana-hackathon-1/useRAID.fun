import type { PrismaClient, Prisma } from '@prisma/client';
import type { CommandReceiptTransaction as Tx } from '../../src/command-receipts';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { matchesBlockingObservation } from './lock-observation';

const txOptions = { transaction: { timeout: 15000, maxWait: 15000 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const pid = async (tx: Prisma.TransactionClient) =>
  (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;

/** Polls the waiter's own backend until it is blocked by the holder's backend inside an engagement lock statement. */
async function waitFor(db: PrismaClient, waiter: number, blocker: number, statement: RegExp) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [row] = (await db.$queryRawUnsafe(
      'SELECT query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1::int',
      String(waiter),
    )) as { query: string; blockers: number[] }[];
    if (matchesBlockingObservation(row, blocker, statement)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected database blocking relationship was not observed.');
}

/**
 * An amendment acceptance that takes the engagement lock, writes the real (guarded) amendment rows — which are not an
 * Engagement row write — and stays uncommitted until released.
 */
export function holdAcceptedAmendment(
  db: PrismaClient,
  engagementId: string,
  proposer: string,
  decider: string,
  patch: { deadlines: Record<string, string> },
) {
  const locked = deferred<number>(),
    release = deferred<void>();
  const done = db.$transaction(async (t) => {
    await t.$queryRawUnsafe(
      'SELECT 1 FROM "Engagement" WHERE "id"=$1::uuid FOR UPDATE',
      engagementId,
    );
    await t.$executeRawUnsafe(
      `INSERT INTO "EngagementAmendment" ("engagementId","sequence","snapshot","digest","proposedByAccountId","expiresAt")
       SELECT $1::uuid,1,s.eff || jsonb_build_object('deadlines', s.eff->'deadlines' || $3::jsonb),repeat('a',64),$2,
         (s.eff->'deadlines'->>'submission')::timestamptz-interval '1 second'
       FROM (SELECT raid_effective_terms($1::uuid) AS eff) s`,
      engagementId,
      proposer,
      JSON.stringify(patch.deadlines),
    );
    await t.$executeRawUnsafe(
      `UPDATE "EngagementAmendment" SET "state"='ACCEPTED',"decidedByAccountId"=$2,"consentRef"='consent-test',"decidedAt"=clock_timestamp() WHERE "engagementId"=$1::uuid`,
      engagementId,
      decider,
    );
    locked.resolve(await pid(t));
    await release.promise;
  }, txOptions.transaction);
  return { locked: locked.promise, release: release.resolve, done };
}

/** Runs `command` while the holder owns the engagement lock; the amendment commits only after it is seen waiting. */
export async function runBehindAmendment<T>(
  db: PrismaClient,
  holder: ReturnType<typeof holdAcceptedAmendment>,
  command: (port: Tx) => Promise<T>,
) {
  const waiter = deferred<number>();
  const blocker = await Promise.race([
    holder.locked,
    holder.done.then(() => {
      throw Error('Amendment ended before holding the lock.');
    }),
  ]);
  const waiting = runCommandTransaction(
    db,
    async (port, tx) => {
      waiter.resolve(await pid(tx));
      return command(port);
    },
    txOptions,
  );
  const outcome = waiting.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await waitFor(
      db,
      await Promise.race([
        waiter.promise,
        waiting.then(() => {
          throw Error('Command ended before it was observed waiting.');
        }),
      ]),
      blocker,
      /"Engagement".*FOR UPDATE/s,
    );
  } finally {
    holder.release();
    await holder.done;
  }
  return outcome;
}
