import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { canonicalRequestDigest } from '../src/command-receipts';
import { saveRaidTerms } from '../src/work-loop/storage';
import { CommandReceiptError } from '../src/command-receipts';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { TermsSnapshotSchema } from '../src/contracts/entities';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import {
  seedWorkHuman,
  seedWorkSlot,
  syntheticAcceptanceHost as host,
} from './helpers/work-loop-db';
import { matchesBlockingObservation } from './helpers/lock-observation';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const txOptions = { transaction: { timeout: 15000, maxWait: 15000 } };
const cmd = (
  actor: Awaited<ReturnType<typeof seedWorkHuman>>['actor'],
  slot: Awaited<ReturnType<typeof seedWorkSlot>>,
  key: string = randomUUID(),
) => ({
  actor,
  input: { slotId: slot.slotId, termsVersionId: slot.termsVersionId },
  idempotencyKey: key,
  requestId: 'test:' + key,
});
const accept = (c: ReturnType<typeof cmd>, h = host) =>
  runCommandTransaction(db, (tx) => commitEngagement(tx, c, h), txOptions);
const rows = <T>(sql: string, ...args: string[]) => db.$queryRawUnsafe<T[]>(sql, ...args);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const pid = async (tx: Prisma.TransactionClient) =>
  (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid;
async function waitFor(waiter: number, blocker: number, statement: RegExp) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [row] = await rows<{ query: string; blockers: number[] }>(
      'SELECT query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1::int',
      String(waiter),
    );
    if (matchesBlockingObservation(row, blocker, statement)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('Expected database blocking relationship was not observed.');
}
integration('T020 canonical engagement capacity', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('atomically snapshots exact terms, owns one slot and reserves canonical HUMAN capacity in ACCESS_PENDING', async () => {
    const human = await seedWorkHuman(db),
      slot = await seedWorkSlot(db),
      result = await accept(cmd(human.actor, slot));
    expect(result.engagement.state).toBe('ACCESS_PENDING');
    expect(result.fundingMode).toBe('SIMULATED');
    expect(result.generation).toBe(1);
    expect(TermsSnapshotSchema.safeParse(result.engagement.acceptedTerms).success).toBe(true);
    expect(result.engagement.acceptedTerms.id).toBe(slot.termsVersionId);
    expect(result.engagement.acceptedTerms.roster.map((x) => x.participantId)).toEqual([
      human.participantId,
    ]);
    expect(result.engagement.acceptedTerms.rewards[0]).toMatchObject({
      amount: slot.terms.rewards[0].amount,
      beneficiaryParticipantId: human.participantId,
    });
    expect(
      await rows('SELECT "participantId"::text,"engagementId"::text FROM "ActiveCommitment"'),
    ).toEqual([{ participantId: human.participantId, engagementId: result.engagement.id }]);
    expect(await rows('SELECT "state" FROM "RaidSlot" WHERE "id"=$1::uuid', slot.slotId)).toEqual([
      { state: 'FILLED' },
    ]);
    expect(
      await db.auditEvent.count({ where: { eventType: 'work.engagement_committed.v1' } }),
    ).toBe(1);
  });
  it('rejects a busy canonical participant and rolls back source, engagement, receipt, audit and outbox', async () => {
    const human = await seedWorkHuman(db),
      first = await seedWorkSlot(db),
      second = await seedWorkSlot(db);
    const existing = await accept(cmd(human.actor, first));
    const c = cmd(human.actor, second);
    await expect(accept(c)).rejects.toMatchObject({
      code: 'CAPACITY_CONFLICT',
      currentEngagementId: existing.engagement.id,
    });
    expect(await rows('SELECT "id" FROM "Engagement"')).toHaveLength(1);
    expect(await rows('SELECT "state" FROM "RaidSlot" WHERE "id"=$1::uuid', second.slotId)).toEqual(
      [{ state: 'AVAILABLE' }],
    );
    expect(await db.commandReceipt.count({ where: { idempotencyKey: c.idempotencyKey } })).toBe(0);
    expect(
      await db.auditEvent.count({ where: { eventType: 'work.engagement_committed.v1' } }),
    ).toBe(1);
  });
  it('reauthorizes replay when writes/eligibility/funding are disabled and rejects changed intent', async () => {
    const human = await seedWorkHuman(db),
      slot = await seedWorkSlot(db),
      c = cmd(human.actor, slot),
      one = await accept(c);
    expect(
      await accept(c, {
        ...host,
        allowNewWrites: false,
        assess: async () => null,
        fundingAvailable: async () => false,
      }),
    ).toEqual({ ...one, status: 'REPLAYED' });
    await expect(
      accept({ ...c, input: { ...c.input, termsVersionId: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await db.session.delete({ where: { tokenHash: human.actor.sessionHash } });
    await expect(accept(c)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it.each([
    'disabled',
    'eligibility',
    'funding',
    'suspended',
    'expired',
    'foreign-session',
  ] as const)('denies current %s without reserving anything', async (reason) => {
    const human = await seedWorkHuman(db),
      other = await seedWorkHuman(db),
      slot = await seedWorkSlot(db);
    let h = host,
      a = human.actor;
    if (reason === 'disabled') h = { ...host, allowNewWrites: false };
    if (reason === 'eligibility') h = { ...host, assess: async () => null };
    if (reason === 'funding') h = { ...host, fundingAvailable: async () => false };
    if (reason === 'suspended')
      await db.user.update({ where: { id: a.accountId }, data: { suspended: true } });
    if (reason === 'expired')
      await db.session.update({
        where: { tokenHash: a.sessionHash },
        data: { expiresAt: new Date(0) },
      });
    if (reason === 'foreign-session') a = { ...a, sessionHash: other.actor.sessionHash };
    await expect(accept(cmd(a, slot), h)).rejects.toMatchObject({
      code: {
        disabled: 'WRITES_DISABLED',
        eligibility: 'ELIGIBILITY_REJECTED',
        funding: 'FUNDING_REQUIRED',
        suspended: 'ACCOUNT_RESTRICTED',
        expired: 'UNAUTHENTICATED',
        'foreign-session': 'UNAUTHENTICATED',
      }[reason],
    });
    expect(await rows('SELECT "id" FROM "Engagement"')).toHaveLength(0);
    expect(await rows('SELECT "participantId" FROM "ActiveCommitment"')).toHaveLength(0);
  });
  it('rechecks exact current terms and the commitment deadline after publication', async () => {
    const human = await seedWorkHuman(db),
      slot = await seedWorkSlot(db);
    await expect(
      accept({
        ...cmd(human.actor, slot),
        input: { slotId: slot.slotId, termsVersionId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'TERMS_VERSION_CHANGED' });
  });
  it.each(['same-participant', 'same-slot'] as const)(
    'proves exactly one independent-transaction winner: %s',
    async (kind) => {
      const a = await seedWorkHuman(db),
        b = kind === 'same-participant' ? a : await seedWorkHuman(db),
        s1 = await seedWorkSlot(db),
        s2 = kind === 'same-slot' ? s1 : await seedWorkSlot(db);
      const ready = deferred<number>(),
        waiter = deferred<number>(),
        release = deferred<void>();
      const first = runCommandTransaction(
        db,
        async (port, tx) => {
          const result = await commitEngagement(port, cmd(a.actor, s1), host);
          ready.resolve(await pid(tx));
          await release.promise;
          return result;
        },
        txOptions,
      );
      let second: Promise<unknown> | undefined;
      try {
        const blocker = await Promise.race([
          ready.promise,
          first.then(() => {
            throw Error('First attempt ended before its barrier.');
          }),
        ]);
        second = runCommandTransaction(
          db,
          async (port, tx) => {
            waiter.resolve(await pid(tx));
            return commitEngagement(port, cmd(b.actor, s2), host);
          },
          txOptions,
        );
        const results = Promise.allSettled([first, second]);
        await waitFor(
          await Promise.race([
            waiter.promise,
            second.then(() => {
              throw Error('Second attempt ended before observing its backend.');
            }),
          ]),
          blocker,
          kind === 'same-participant'
            ? /INSERT INTO "ActiveCommitment"/
            : /WorkListing.*FOR UPDATE/,
        );
        release.resolve();
        const settled = await results;
        expect(settled[0].status).toBe('fulfilled');
        expect(settled[1]).toMatchObject({
          status: 'rejected',
          reason: { code: kind === 'same-participant' ? 'CAPACITY_CONFLICT' : 'SLOT_FILLED' },
        });
        expect(await rows('SELECT "id" FROM "Engagement"')).toHaveLength(1);
        expect(await rows('SELECT "participantId" FROM "ActiveCommitment"')).toHaveLength(1);
        expect(
          await db.auditEvent.count({ where: { eventType: 'work.engagement_committed.v1' } }),
        ).toBe(1);
      } finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );
  it('cannot let an injected assessor mutate the immutable accepted scope', async () => {
    const human = await seedWorkHuman(db),
      slot = await seedWorkSlot(db);
    await expect(
      accept(cmd(human.actor, slot), {
        ...host,
        assess: async (tx, c) => {
          c.terms.deliverables[0] = 'FORGED CALLBACK SCOPE';
          return host.assess(tx, c);
        },
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
    expect(await rows('SELECT "id" FROM "Engagement"')).toHaveLength(0);
  });
  it('rechecks the finite acceptance window after a potentially blocking capacity acquisition', async () => {
    const human = await seedWorkHuman(db),
      slot = await seedWorkSlot(db),
      c = cmd(human.actor, slot);
    await expect(
      runCommandTransaction(
        db,
        async (port) => {
          let capacityAcquired = false;
          return commitEngagement(
            {
              ...port,
              async query<Row>(sql: string, bindings: readonly (string | null)[]) {
                const result = await port.query<Row>(sql, bindings);
                if (sql.startsWith('INSERT INTO "ActiveCommitment"')) capacityAcquired = true;
                // Deterministic clock observation at the port; real-PG races are separate tests above.
                if (capacityAcquired && sql === 'SELECT clock_timestamp() AS now')
                  return [{ now: new Date(slot.terms.deadlines.commitment) }] as Row[];
                return result;
              },
            },
            c,
            host,
          );
        },
        txOptions,
      ),
    ).rejects.toMatchObject({ code: 'DEADLINE_PASSED' });
    expect(await rows('SELECT "id" FROM "Engagement"')).toHaveLength(0);
    expect(await db.commandReceipt.count({ where: { idempotencyKey: c.idempotencyKey } })).toBe(0);
  });
  it('rejects raw orphan engagements, phantom filled slots and deletion of active reservations', async () => {
    const human = await seedWorkHuman(db),
      first = await seedWorkSlot(db),
      second = await seedWorkSlot(db);
    const saved = await accept(cmd(human.actor, first));
    await expect(
      rows(
        'UPDATE "RaidSlot" SET "state"=\'FILLED\' WHERE "id"=$1::uuid RETURNING "id"',
        second.slotId,
      ),
    ).rejects.toThrow();
    const accepted = { ...saved.engagement.acceptedTerms, id: second.termsVersionId };
    await expect(
      rows(
        'INSERT INTO "Engagement" ("slotId","termsVersionId","guildId","acceptedTerms","acceptedDigest") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5) RETURNING "id"',
        second.slotId,
        second.termsVersionId,
        'synthetic-guild',
        JSON.stringify(accepted),
        canonicalRequestDigest(accepted),
      ),
    ).rejects.toThrow();
    await expect(
      rows(
        'DELETE FROM "ActiveCommitment" WHERE "participantId"=$1::uuid RETURNING "participantId"',
        human.participantId,
      ),
    ).rejects.toThrow();
    await expect(
      rows(
        'UPDATE "Engagement" SET "acceptedTerms"=\'{}\'::jsonb WHERE "id"=$1::uuid RETURNING "id"',
        saved.engagement.id,
      ),
    ).rejects.toThrow();
    expect(await rows('SELECT "id" FROM "Engagement"')).toHaveLength(1);
    expect(await rows('SELECT "participantId" FROM "ActiveCommitment"')).toHaveLength(1);
    expect(await rows('SELECT "state" FROM "RaidSlot" WHERE "id"=$1::uuid', second.slotId)).toEqual(
      [{ state: 'AVAILABLE' }],
    );
  });
  it('denies a revoked session after a real identity-child lock wait, before assessor access', async () => {
    const human = await seedWorkHuman(db),
      slot = await seedWorkSlot(db),
      ready = deferred<number>(),
      waiter = deferred<number>(),
      release = deferred<void>();
    let assessed = 0;
    const revoker = db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "tokenHash" FROM "Session" WHERE "tokenHash"=$1 FOR UPDATE',
          human.actor.sessionHash,
        );
        await tx.session.delete({ where: { tokenHash: human.actor.sessionHash } });
        ready.resolve(await pid(tx));
        await release.promise;
      },
      { timeout: 15000 },
    );
    let pending: Promise<unknown> | undefined;
    try {
      const blocker = await Promise.race([
        ready.promise,
        revoker.then(() => {
          throw Error('Revoker ended before its barrier.');
        }),
      ]);
      pending = runCommandTransaction(
        db,
        async (port, tx) => {
          waiter.resolve(await pid(tx));
          return commitEngagement(port, cmd(human.actor, slot), {
            ...host,
            assess: async (tx, c) => {
              assessed++;
              return host.assess(tx, c);
            },
          });
        },
        txOptions,
      );
      const results = Promise.allSettled([revoker, pending]);
      await waitFor(await waiter.promise, blocker, /Session.*FOR SHARE/);
      release.resolve();
      const settled = await results;
      expect(settled[0].status).toBe('fulfilled');
      expect(settled[1]).toMatchObject({ status: 'rejected', reason: { code: 'UNAUTHENTICATED' } });
      expect(assessed).toBe(0);
      expect(await rows('SELECT "id" FROM "Engagement"')).toHaveLength(0);
    } finally {
      release.resolve();
      await Promise.allSettled([revoker, ...(pending ? [pending] : [])]);
    }
  });
  it('AC13 storage shape: one busy member rolls back the complete synthetic multi-member allocation', async () => {
    const busy = await seedWorkHuman(db),
      free = await seedWorkHuman(db),
      solo = await seedWorkSlot(db);
    const previous = await accept(cmd(busy.actor, solo));
    const founder = 'party-fixture-' + randomUUID();
    await db.user.create({ data: { id: founder, handle: founder } });
    const saved = await runCommandTransaction(db, (port) =>
      saveRaidTerms(
        port,
        {
          actor: { accountId: founder, sessionHash: 'f'.repeat(64) },
          input: {
            listingId: null,
            expectedRevision: 0,
            guildId: 'synthetic-guild',
            terms: { ...solo.terms, execution: 'PARTY' },
          },
          idempotencyKey: randomUUID(),
          requestId: 'party-storage-fixture',
        },
        {
          allowNewWrites: true,
          authorize: async () => true,
          reserveSimulatedFunding: async () => null,
        },
      ),
    );
    // Storage fixture only. The public HUMAN/SOLO command still rejects Party admission.
    const slotId = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO "RaidSlot" ("id","listingId","termsVersionId","slotNumber","fundingRef") VALUES ($1::uuid,$2::uuid,$3::uuid,1,$4)',
        slotId,
        saved.listingId,
        saved.termsVersionId,
        'synthetic-party:' + slotId,
      );
      await tx.$executeRawUnsafe(
        'UPDATE "WorkListing" SET "state"=\'OPEN\' WHERE "id"=$1::uuid',
        saved.listingId,
      );
    });
    const accepted = {
      ...previous.engagement.acceptedTerms,
      id: saved.termsVersionId,
      roster: [
        ...previous.engagement.acceptedTerms.roster,
        {
          participantId: free.participantId,
          responsibility: 'SYNTHETIC_CONSENTED_MEMBER',
          consentRef: 'synthetic-zero-share-consent:' + free.participantId,
        },
      ],
    };
    await expect(
      db.$transaction(async (tx) => {
        const [e] = await tx.$queryRawUnsafe<{ id: string }[]>(
          'INSERT INTO "Engagement" ("slotId","termsVersionId","guildId","acceptedTerms","acceptedDigest") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5) RETURNING "id"::text',
          slotId,
          saved.termsVersionId,
          'synthetic-guild',
          JSON.stringify(accepted),
          canonicalRequestDigest(accepted),
        );
        for (const id of [busy.participantId, free.participantId].sort())
          await tx.$executeRawUnsafe(
            'INSERT INTO "EngagementMember" VALUES ($1::uuid,$2::uuid,$3::uuid)',
            e.id,
            id,
            saved.termsVersionId,
          );
        await tx.$executeRawUnsafe(
          'INSERT INTO "ActiveCommitment" ("participantId","engagementId","termsVersionId") VALUES ($1::uuid,$2::uuid,$3::uuid)',
          free.participantId,
          e.id,
          saved.termsVersionId,
        );
        await tx.$executeRawUnsafe(
          'INSERT INTO "ActiveCommitment" ("participantId","engagementId","termsVersionId") VALUES ($1::uuid,$2::uuid,$3::uuid)',
          busy.participantId,
          e.id,
          saved.termsVersionId,
        );
      }),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23505' } });
    expect(await rows('SELECT "id" FROM "Engagement"')).toHaveLength(1);
    expect(
      await rows(
        'SELECT "participantId" FROM "ActiveCommitment" WHERE "participantId"=$1::uuid',
        free.participantId,
      ),
    ).toHaveLength(0);
    expect(await rows('SELECT "state" FROM "RaidSlot" WHERE "id"=$1::uuid', slotId)).toEqual([
      { state: 'AVAILABLE' },
    ]);
  });
  it('rolls back a whole attempt and retries with the original command identity', async () => {
    const human = await seedWorkHuman(db),
      slot = await seedWorkSlot(db),
      c = cmd(human.actor, slot);
    let attempts = 0;
    const result = await runCommandTransaction(
      db,
      async (port) => {
        const saved = await commitEngagement(port, c, host);
        if (++attempts === 1) throw new CommandReceiptError('RETRY_TRANSACTION');
        return saved;
      },
      txOptions,
    );
    expect(attempts).toBe(2);
    expect(result.engagement.state).toBe('ACCESS_PENDING');
    expect(await rows('SELECT "id" FROM "Engagement"')).toHaveLength(1);
    expect(await rows('SELECT "participantId" FROM "ActiveCommitment"')).toHaveLength(1);
  });
});
