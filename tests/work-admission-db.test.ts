import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import {
  submitApplication,
  withdrawApplication,
  issueOffer,
  revokeOffer,
} from '../src/work-loop/admission-storage';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import type { AdmissionHost } from '../src/work-loop/admission-contracts';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const cmd = (
  actor: { accountId: string; sessionHash: string },
  input: unknown,
  key = randomUUID(),
) => ({ actor, input, idempotencyKey: key, requestId: key });
const host: AdmissionHost = {
  allowNewWrites: true,
  applicationLimit: 5,
  authorize: async (_tx, a) => a.accountId.startsWith('founder-'),
};
async function setup() {
  const applicant = await seedWorkHuman(db),
    founder = await seedWorkHuman(db, 'founder-' + randomUUID());
  const slot = await seedWorkSlot(db, founder.actor.accountId, { admission: 'APPLICATION' });
  const apply = cmd(applicant.actor, {
    slotId: slot.slotId,
    termsVersionId: slot.termsVersionId,
    evidenceRefs: ['synthetic:portfolio'],
  });
  return { applicant, founder, slot, apply };
}
const applyTo = (c: ReturnType<typeof cmd>, h = host) => run((tx) => submitApplication(tx, c, h));
const offerTo = (c: ReturnType<typeof cmd>, h = host) => run((tx) => issueOffer(tx, c, h));
integration('T021 applications and offers', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('keeps application and exact-version founder offer nonbinding, then commits through canonical acceptance', async () => {
    const { applicant, founder, slot, apply } = await setup();
    const application = await applyTo(apply);
    expect(application.application.state).toBe('SUBMITTED');
    expect(await db.$queryRawUnsafe('SELECT * FROM "ActiveCommitment"')).toEqual([]);
    const offer = await offerTo(
      cmd(founder.actor, {
        applicationId: application.application.id,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    expect(offer.offer.termsVersionId).toBe(slot.termsVersionId);
    expect(await db.$queryRawUnsafe('SELECT * FROM "ActiveCommitment"')).toEqual([]);
    const accepted = await run((tx) =>
      commitEngagement(
        tx,
        cmd(applicant.actor, {
          slotId: slot.slotId,
          termsVersionId: slot.termsVersionId,
          offerId: offer.offer.id,
        }),
        syntheticAcceptanceHost,
      ),
    );
    expect(accepted.engagement.state).toBe('ACCESS_PENDING');
    expect(await db.$queryRawUnsafe('SELECT "state" FROM "RaidOffer"')).toEqual([
      { state: 'ACCEPTED' },
    ]);
    expect(await db.$queryRawUnsafe('SELECT "state" FROM "RaidApplication"')).toEqual([
      { state: 'CLOSED' },
    ]);
  });
  it('rejects a stale offer once its participant becomes busy and preserves the available source', async () => {
    const { applicant, founder, slot, apply } = await setup();
    const application = await applyTo(apply),
      offer = await offerTo(
        cmd(founder.actor, {
          applicationId: application.application.id,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
    const another = await seedWorkSlot(db);
    await run((tx) =>
      commitEngagement(
        tx,
        cmd(applicant.actor, { slotId: another.slotId, termsVersionId: another.termsVersionId }),
        syntheticAcceptanceHost,
      ),
    );
    await expect(
      run((tx) =>
        commitEngagement(
          tx,
          cmd(applicant.actor, {
            slotId: slot.slotId,
            termsVersionId: slot.termsVersionId,
            offerId: offer.offer.id,
          }),
          syntheticAcceptanceHost,
        ),
      ),
    ).rejects.toMatchObject({ code: 'CAPACITY_CONFLICT' });
    expect(await db.$queryRawUnsafe('SELECT "state" FROM "RaidOffer"')).toEqual([
      { state: 'PENDING' },
    ]);
  });
  it('enforces the configurable open-application cap and frees a withdrawn or revoked-offer path immediately', async () => {
    const { applicant, founder, apply } = await setup();
    const first = await applyTo(apply, { ...host, applicationLimit: 1 });
    const another = await seedWorkSlot(db, founder.actor.accountId, { admission: 'APPLICATION' }),
      second = cmd(applicant.actor, {
        slotId: another.slotId,
        termsVersionId: another.termsVersionId,
        evidenceRefs: [],
      });
    await expect(applyTo(second, { ...host, applicationLimit: 1 })).rejects.toMatchObject({
      code: 'APPLICATION_LIMIT',
    });
    const offered = await offerTo(
      cmd(founder.actor, {
        applicationId: first.application.id,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    await run((tx) => revokeOffer(tx, cmd(founder.actor, { offerId: offered.offer.id }), host));
    const saved = await applyTo(second, { ...host, applicationLimit: 1 });
    await run((tx) =>
      withdrawApplication(tx, cmd(applicant.actor, { applicationId: saved.application.id }), host),
    );
    expect(await db.$queryRawUnsafe('SELECT * FROM "ActiveCommitment"')).toEqual([]);
  });
  it('denies foreign founders/offer recipients and preserves replay while writes are disabled', async () => {
    const { applicant, founder, slot, apply } = await setup(),
      foreign = await seedWorkHuman(db);
    const saved = await applyTo(apply);
    expect((await applyTo(apply, { ...host, allowNewWrites: false })).status).toBe('REPLAYED');
    await expect(
      offerTo(
        cmd(foreign.actor, {
          applicationId: saved.application.id,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const offer = await offerTo(
      cmd(founder.actor, {
        applicationId: saved.application.id,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    await expect(
      run((tx) =>
        commitEngagement(
          tx,
          cmd(foreign.actor, {
            slotId: slot.slotId,
            termsVersionId: slot.termsVersionId,
            offerId: offer.offer.id,
          }),
          syntheticAcceptanceHost,
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      applyTo({ ...apply, input: { ...(apply.input as object), evidenceRefs: ['changed'] } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await db.session.delete({ where: { tokenHash: applicant.actor.sessionHash } });
    await expect(applyTo(apply)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('rejects changed command intent before looking up a substituted missing source', async () => {
    const { apply } = await setup();
    await applyTo(apply);
    await expect(
      applyTo({ ...apply, input: { ...(apply.input as object), slotId: randomUUID() } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('does not revive a revoked application path outside its current quota', async () => {
    const { founder, apply } = await setup();
    const a = await applyTo(apply);
    const value = cmd(founder.actor, {
      applicationId: a.application.id,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const o = await offerTo(value);
    await run((tx) => revokeOffer(tx, cmd(founder.actor, { offerId: o.offer.id }), host));
    await expect(offerTo({ ...value, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'APPLICATION_CLOSED',
    });
  });
  it('excludes an actually expired offer from quota and rejects its acceptance', async () => {
    const { applicant, founder, slot, apply } = await setup(),
      a = await applyTo(apply, { ...host, applicationLimit: 1 });
    const expiresAt = new Date(Date.now() + 250).toISOString();
    const o = await offerTo(cmd(founder.actor, { applicationId: a.application.id, expiresAt }));
    const until = Date.now() + 5000;
    let expired = false;
    while (Date.now() < until) {
      const [r] = await db.$queryRawUnsafe<{ expired: boolean }[]>(
        'SELECT clock_timestamp()>$1::timestamptz AS expired',
        expiresAt,
      );
      if (r.expired) {
        expired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(expired).toBe(true);
    await expect(
      run((tx) =>
        commitEngagement(
          tx,
          cmd(applicant.actor, {
            slotId: slot.slotId,
            termsVersionId: slot.termsVersionId,
            offerId: o.offer.id,
          }),
          syntheticAcceptanceHost,
        ),
      ),
    ).rejects.toMatchObject({ code: 'OFFER_UNAVAILABLE' });
    const renewed = await applyTo(
      { ...apply, idempotencyKey: randomUUID() },
      { ...host, applicationLimit: 1 },
    );
    expect(renewed.application.id).not.toBe(a.application.id);
    await run((tx) =>
      withdrawApplication(
        tx,
        cmd(applicant.actor, { applicationId: renewed.application.id }),
        host,
      ),
    );
    const another = await seedWorkSlot(db, founder.actor.accountId, { admission: 'APPLICATION' });
    await expect(
      applyTo(
        cmd(applicant.actor, {
          slotId: another.slotId,
          termsVersionId: another.termsVersionId,
          evidenceRefs: [],
        }),
        { ...host, applicationLimit: 1 },
      ),
    ).resolves.toMatchObject({ status: 'EXECUTED' });
  });
  it('serializes concurrent application-cap acquisition across different sources', async () => {
    const { applicant, founder, apply } = await setup(),
      other = await seedWorkSlot(db, founder.actor.accountId, { admission: 'APPLICATION' });
    let release!: () => void, ready!: (pid: number) => void;
    const held = new Promise<void>((r) => (release = r)),
      started = new Promise<number>((r) => (ready = r));
    const first = run(async (port, tx) => {
      const saved = await submitApplication(port, apply, { ...host, applicationLimit: 1 });
      ready((await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid);
      await held;
      return saved;
    });
    let second: Promise<unknown> | undefined;
    try {
      const blocker = await Promise.race([
        started,
        first.then(() => {
          throw Error('first ended before barrier');
        }),
      ]);
      let waiter!: (pid: number) => void;
      const waiting = new Promise<number>((r) => (waiter = r));
      second = run(async (port, tx) => {
        waiter(
          (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid,
        );
        return submitApplication(
          port,
          cmd(applicant.actor, {
            slotId: other.slotId,
            termsVersionId: other.termsVersionId,
            evidenceRefs: [],
          }),
          { ...host, applicationLimit: 1 },
        );
      });
      const settled = Promise.allSettled([first, second]),
        pid = await waiting,
        until = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < until) {
        const [r] = await db.$queryRawUnsafe<{ blockers: number[]; query: string }[]>(
          'SELECT pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1',
          pid,
        );
        if (r?.blockers.includes(blocker) && /User.*FOR UPDATE/.test(r.query)) {
          blocked = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
      release();
      expect(await settled).toMatchObject([
        { status: 'fulfilled' },
        { status: 'rejected', reason: { code: 'APPLICATION_LIMIT' } },
      ]);
      expect(await db.$queryRawUnsafe('SELECT * FROM "RaidApplication"')).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });
  it.each(['accept', 'revoke'] as const)(
    'proves the %s winner against the competing offer command',
    async (kind) => {
      const { applicant, founder, slot, apply } = await setup(),
        a = await applyTo(apply),
        o = await offerTo(
          cmd(founder.actor, {
            applicationId: a.application.id,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
      const accept = () =>
        cmd(applicant.actor, {
          slotId: slot.slotId,
          termsVersionId: slot.termsVersionId,
          offerId: o.offer.id,
        });
      const revoke = () => cmd(founder.actor, { offerId: o.offer.id });
      const action = (port: Parameters<typeof commitEngagement>[0], which: 'accept' | 'revoke') =>
        which === 'accept'
          ? commitEngagement(port, accept(), syntheticAcceptanceHost)
          : revokeOffer(port, revoke(), host);
      let release!: () => void, ready!: (pid: number) => void;
      const held = new Promise<void>((r) => (release = r)),
        started = new Promise<number>((r) => (ready = r));
      const first = run(async (port, tx) => {
        const saved = await action(port, kind);
        ready(
          (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid,
        );
        await held;
        return saved;
      });
      let second: Promise<unknown> | undefined;
      try {
        const blocker = await Promise.race([
          started,
          first.then(() => {
            throw Error('first ended before barrier');
          }),
        ]);
        let waiter!: (pid: number) => void;
        const waiting = new Promise<number>((r) => (waiter = r));
        second = run(async (port, tx) => {
          waiter(
            (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0].pid,
          );
          return action(port, kind === 'accept' ? 'revoke' : 'accept');
        });
        const settled = Promise.allSettled([first, second]),
          pid = await waiting,
          until = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < until) {
          const [r] = await db.$queryRawUnsafe<{ blockers: number[]; query: string }[]>(
            'SELECT pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity WHERE pid=$1',
            pid,
          );
          if (r?.blockers.includes(blocker) && /WorkListing.*FOR UPDATE/.test(r.query)) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(blocked).toBe(true);
        release();
        expect(await settled).toMatchObject([
          { status: 'fulfilled' },
          { status: 'rejected', reason: { code: 'OFFER_UNAVAILABLE' } },
        ]);
        expect(await db.$queryRawUnsafe('SELECT * FROM "Engagement"')).toHaveLength(
          kind === 'accept' ? 1 : 0,
        );
      } finally {
        release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );
});
