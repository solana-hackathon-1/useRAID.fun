// Author-run SQL experiments for a proposed protocol, not application implementation.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabase, truncateAll } from '../../../../tests/helpers/db-guard';

const db = new PrismaClient();
const holder = new PrismaClient({ transactionOptions: { timeout: 15000 } });
const observer = new PrismaClient();
async function hold(sql: string, key: string) {
  let ready!: (pid: number) => void;
  let release!: () => void;
  const started = new Promise<number>((resolve) => (ready = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = holder.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await tx.$queryRawUnsafe(sql, key);
    ready(pid);
    await gate;
  });
  return { pid: await started, release, held };
}
async function blockedBy(pid: number, needle: string) {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<{ pid: number; query: string }[]>`
      SELECT pid, query FROM pg_stat_activity
      WHERE datname=current_database() AND ${pid}::integer=ANY(pg_blocking_pids(pid))`;
    const row = rows.find((r) => r.query.includes(needle));
    if (row) {
      console.info(JSON.stringify({ primitiveWait: { blocker: pid, waiter: row.pid, needle } }));
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No observed blocker for ${needle}`);
}

describe('proposed protocol database primitives', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => Promise.all([db.$disconnect(), holder.$disconnect(), observer.$disconnect()]));

  it('updating unique User.xId upgrades NO KEY UPDATE and waits for KEY SHARE', async () => {
    const user = await db.user.create({ data: { handle: 'synthetic' } });
    const gate = await hold('SELECT id FROM "User" WHERE id=$1 FOR KEY SHARE', user.id);
    let change: Promise<unknown> | undefined;
    try {
      change = db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id=${user.id} FOR NO KEY UPDATE`;
        await tx.user.update({ where: { id: user.id }, data: { xId: 'synthetic-upgrade' } });
      });
      await blockedBy(gate.pid, 'UPDATE');
      gate.release();
      await gate.held;
      await change;
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).xId).toBe(
        'synthetic-upgrade',
      );
    } finally {
      gate.release();
      await gate.held;
      await Promise.allSettled([change]);
    }
  });

  it('non-key User.suspended update succeeds while KEY SHARE is held', async () => {
    const user = await db.user.create({ data: { handle: 'synthetic' } });
    const gate = await hold('SELECT id FROM "User" WHERE id=$1 FOR KEY SHARE', user.id);
    try {
      await db.user.update({ where: { id: user.id }, data: { suspended: true } });
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).suspended).toBe(true);
    } finally {
      gate.release();
      await gate.held;
    }
  });

  it('materialized attempt sweep deletes only unlocked expired rows and progresses next run', async () => {
    const future = new Date(Date.now() + 60000),
      past = new Date(Date.now() - 60000);
    for (const [stateHash, expiresAt] of [
      ['a', past],
      ['f', past],
      ['z', future],
    ] as const)
      await db.oAuthAttempt.create({ data: { stateHash, verifier: 'synthetic', expiresAt } });
    const gate = await hold(
      'SELECT "stateHash" FROM "OAuthAttempt" WHERE "stateHash"=$1 FOR UPDATE',
      'f',
    );
    const sweep = () => db.$queryRaw<{ stateHash: string }[]>`
      WITH doomed AS MATERIALIZED (
        SELECT "stateHash" FROM "OAuthAttempt" WHERE "expiresAt" <= clock_timestamp()
        ORDER BY "stateHash" FOR UPDATE SKIP LOCKED
      ) DELETE FROM "OAuthAttempt" AS target USING doomed
        WHERE target."stateHash"=doomed."stateHash" RETURNING target."stateHash"`;
    try {
      // Returned while the holder is still open: the sweep did not wait for its locked row.
      expect(await sweep()).toEqual([{ stateHash: 'a' }]);
      expect(
        await db.oAuthAttempt.findMany({
          orderBy: { stateHash: 'asc' },
          select: { stateHash: true },
        }),
      ).toEqual([{ stateHash: 'f' }, { stateHash: 'z' }]);
      gate.release();
      await gate.held;
      expect(await sweep()).toEqual([{ stateHash: 'f' }]);
      expect(await db.oAuthAttempt.findMany({ select: { stateHash: true } })).toEqual([
        { stateHash: 'z' },
      ]);
    } finally {
      gate.release();
      await gate.held;
    }
  });

  it.each(['Session', 'WalletChallenge'] as const)(
    '%s sweep also skips the locked row',
    async (table) => {
      const user = await db.user.create({ data: { handle: 'synthetic' } });
      for (const key of ['a', 'f']) {
        const expiresAt = new Date(Date.now() - 60000);
        if (table === 'Session')
          await db.session.create({ data: { tokenHash: key, userId: user.id, expiresAt } });
        else
          await db.walletChallenge.create({
            data: { digest: key, address: 'synthetic', message: 'synthetic', expiresAt },
          });
      }
      // Identifiers are selected from this closed test-only enum; values remain bound parameters.
      const pk = table === 'Session' ? 'tokenHash' : 'digest';
      const gate = await hold(`SELECT "${pk}" FROM "${table}" WHERE "${pk}"=$1 FOR UPDATE`, 'f');
      try {
        const result = await db.$queryRawUnsafe(`WITH doomed AS MATERIALIZED (
        SELECT "${pk}" FROM "${table}" WHERE "expiresAt" < clock_timestamp()
        ORDER BY "${pk}" FOR UPDATE SKIP LOCKED)
        DELETE FROM "${table}" AS target USING doomed
        WHERE target."${pk}"=doomed."${pk}" RETURNING target."${pk}"`);
        expect(result).toEqual([{ [pk]: 'a' }]);
      } finally {
        gate.release();
        await gate.held;
      }
    },
  );

  it('ordered root acquisition leaves the higher root available while the lower waits', async () => {
    for (const id of ['a', 'f']) await db.user.create({ data: { id, handle: 'synthetic' } });
    const gate = await hold('SELECT id FROM "User" WHERE id=$1 FOR UPDATE', 'a');
    let roots: Promise<unknown> | undefined;
    try {
      roots = db.$transaction(async (tx) => {
        for (const id of ['a', 'f'])
          await tx.$queryRaw`SELECT id FROM "User" WHERE id=${id} FOR UPDATE`;
      });
      await blockedBy(gate.pid, 'FOR UPDATE');
      await observer.$transaction(
        (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id='f' FOR UPDATE NOWAIT`,
      );
      gate.release();
      await gate.held;
      await roots;
    } finally {
      gate.release();
      await gate.held;
      await Promise.allSettled([roots]);
    }
  });
});
