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
import { recordAcceptanceConsent } from '../src/work-loop/consent-storage';
import type { AdmissionHost } from '../src/work-loop/admission-contracts';
import { saveRaidTerms } from '../src/work-loop/storage';
import type { WorkHost } from '../src/work-loop/contracts';
import { raidTerms } from './helpers/raid-terms-fixture';
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
    ).rejects.toMatchObject({ code: 'OFFER_EXPIRED' });
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
  const expiry = () => new Date(Date.now() + 3600000).toISOString();
  const accept = (
    applicantActor: Parameters<typeof cmd>[0],
    slot: { slotId: string; termsVersionId: string },
    offerId: string,
    h: Parameters<typeof commitEngagement>[2] = syntheticAcceptanceHost,
  ) =>
    run((tx) =>
      commitEngagement(
        tx,
        cmd(applicantActor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId, offerId }),
        h,
      ),
    );
  it('refuses to accept an offer whose issuing Founder lost authority, and fails closed without the host check', async () => {
    const { applicant, founder, slot, apply } = await setup();
    const a = await applyTo(apply);
    const o = await offerTo(
      cmd(founder.actor, { applicationId: a.application.id, expiresAt: expiry() }),
    );
    const issued: unknown[] = [];
    const revoked = {
      ...syntheticAcceptanceHost,
      authorizeOfferIssuer: async (_tx: unknown, issuer: unknown) => (issued.push(issuer), false),
    };
    await expect(accept(applicant.actor, slot, o.offer.id, revoked)).rejects.toMatchObject({
      code: 'OFFER_UNAVAILABLE',
    });
    expect(issued).toEqual([{ accountId: founder.actor.accountId }]);
    const { authorizeOfferIssuer: _omitted, ...withoutCheck } = revoked;
    await expect(accept(applicant.actor, slot, o.offer.id, withoutCheck)).rejects.toMatchObject({
      code: 'STORAGE_CONTRACT',
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "Engagement"')).toEqual([]);
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "ActiveCommitment"')).toEqual([]);
    await expect(accept(applicant.actor, slot, o.offer.id)).resolves.toMatchObject({
      status: 'EXECUTED',
    });
  });
  it('rejects a host without the issuer check before running any host callback or side effect', async () => {
    const { applicant, founder, slot, apply } = await setup();
    const a = await applyTo(apply);
    const o = await offerTo(
      cmd(founder.actor, { applicationId: a.application.id, expiresAt: expiry() }),
    );
    const calls: string[] = [];
    const { authorizeOfferIssuer: _omitted, ...withoutCheck } = syntheticAcceptanceHost;
    const spying = {
      ...withoutCheck,
      assess: async (...args: Parameters<typeof syntheticAcceptanceHost.assess>) => (
        calls.push('assess'),
        syntheticAcceptanceHost.assess(...args)
      ),
      fundingAvailable: async (
        ...args: Parameters<typeof syntheticAcceptanceHost.fundingAvailable>
      ) => (calls.push('fundingAvailable'), syntheticAcceptanceHost.fundingAvailable(...args)),
    };
    await expect(accept(applicant.actor, slot, o.offer.id, spying)).rejects.toMatchObject({
      code: 'STORAGE_CONTRACT',
    });
    expect(calls).toEqual([]);
  });
  const digestOf = async (termsVersionId: string) =>
    (
      (await db.$queryRawUnsafe(
        'SELECT "digest" FROM "TermsVersion" WHERE "id"=$1::uuid',
        termsVersionId,
      )) as {
        digest: string;
      }[]
    )[0].digest;
  const consentTo = (
    actor: Parameters<typeof cmd>[0],
    slot: { slotId: string; termsVersionId: string },
    termsDigest: string,
  ) =>
    run((tx) =>
      recordAcceptanceConsent(
        tx,
        cmd(actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId, termsDigest }),
        { allowNewWrites: true },
      ),
    );
  it('records consent for an application Raid only with the person’s own pending, unexpired offer', async () => {
    const { applicant, founder, slot, apply } = await setup();
    const digest = await digestOf(slot.termsVersionId);
    await expect(consentTo(applicant.actor, slot, digest)).rejects.toMatchObject({
      code: 'ADMISSION_REQUIRED',
    });
    const a = await applyTo(apply);
    await expect(consentTo(applicant.actor, slot, digest)).rejects.toMatchObject({
      code: 'ADMISSION_REQUIRED',
    });
    const o = await offerTo(
      cmd(founder.actor, { applicationId: a.application.id, expiresAt: expiry() }),
    );
    const stranger = await seedWorkHuman(db);
    await expect(consentTo(stranger.actor, slot, digest)).rejects.toMatchObject({
      code: 'ADMISSION_REQUIRED',
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkAcceptanceConsent"')).toEqual([]);
    await expect(consentTo(applicant.actor, slot, digest)).resolves.toMatchObject({
      status: 'EXECUTED',
    });
    await run((tx) => revokeOffer(tx, cmd(founder.actor, { offerId: o.offer.id }), host));
    // A fresh command after the offer was revoked is refused; the consent already recorded stays untouched.
    await expect(consentTo(applicant.actor, slot, digest)).rejects.toMatchObject({
      code: 'ADMISSION_REQUIRED',
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkAcceptanceConsent"')).toHaveLength(1);
  });
  it('refuses consent once the commitment deadline has passed', async () => {
    const human = await seedWorkHuman(db);
    const slot = await seedWorkSlot(db);
    const digest = await digestOf(slot.termsVersionId);
    const [{ commitment }] = (await db.$queryRawUnsafe(
      `SELECT "snapshot"->'deadlines'->>'commitment' AS commitment FROM "TermsVersion" WHERE "id"=$1::uuid`,
      slot.termsVersionId,
    )) as { commitment: string }[];
    await expect(
      run((tx) =>
        recordAcceptanceConsent(
          {
            ...tx,
            async query<Row>(sql: string, bindings: readonly (string | null)[]) {
              // Deterministic clock at the port: the commitment deadline has just been reached.
              if (sql === 'SELECT clock_timestamp() AS now')
                return [{ now: new Date(commitment) }] as Row[];
              return tx.query<Row>(sql, bindings);
            },
          } as typeof tx,
          cmd(human.actor, {
            slotId: slot.slotId,
            termsVersionId: slot.termsVersionId,
            termsDigest: digest,
          }),
          { allowNewWrites: true },
        ),
      ),
    ).rejects.toMatchObject({ code: 'DEADLINE_PASSED' });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "WorkAcceptanceConsent"')).toEqual([]);
  });
  it('revokes outstanding offers and closes their applications when the Founder edits the terms', async () => {
    const { applicant, founder, slot, apply } = await setup();
    const a = await applyTo(apply);
    const o = await offerTo(
      cmd(founder.actor, { applicationId: a.application.id, expiresAt: expiry() }),
    );
    const founderHost: WorkHost = {
      allowNewWrites: true,
      authorize: async (_tx, who, guild) =>
        who.accountId === founder.actor.accountId && guild === 'synthetic-guild',
      reserveSimulatedFunding: async (_tx, b) => 'synthetic:' + b.slotId,
    };
    await run((tx) =>
      saveRaidTerms(
        tx,
        cmd(founder.actor, {
          listingId: slot.listingId,
          expectedRevision: 1,
          guildId: 'synthetic-guild',
          terms: {
            ...raidTerms(),
            admission: 'APPLICATION',
            title: 'Revised synthetic documentation task',
          },
        }),
        founderHost,
      ),
    );
    expect(
      await db.$queryRawUnsafe('SELECT "state" FROM "RaidOffer" WHERE "id"=$1::uuid', o.offer.id),
    ).toEqual([{ state: 'REVOKED' }]);
    expect(
      await db.$queryRawUnsafe(
        'SELECT "state" FROM "RaidApplication" WHERE "id"=$1::uuid',
        a.application.id,
      ),
    ).toEqual([{ state: 'CLOSED' }]);
    await expect(accept(applicant.actor, slot, o.offer.id)).rejects.toMatchObject({
      code: 'PUBLICATION_BLOCKED',
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "Engagement"')).toEqual([]);
    // The transitions are recorded as one event naming the superseded terms version, not left silent.
    const events = (await db.$queryRawUnsafe(
      `SELECT "aggregateId","payload" FROM "AuditEvent" WHERE "eventType"='work.offers_revoked.v1'`,
    )) as { aggregateId: string; payload: { termsVersionId: string } }[];
    expect(events).toHaveLength(1);
    expect(events[0].aggregateId).toBe(slot.listingId);
    expect(events[0].payload.termsVersionId).toBe(slot.termsVersionId);
  });
  it('records no revocation event when a terms edit leaves nothing outstanding', async () => {
    const { founder, slot } = await setup();
    const founderHost: WorkHost = {
      allowNewWrites: true,
      authorize: async (_tx, who, guild) =>
        who.accountId === founder.actor.accountId && guild === 'synthetic-guild',
      reserveSimulatedFunding: async (_tx, b) => 'synthetic:' + b.slotId,
    };
    await run((tx) =>
      saveRaidTerms(
        tx,
        cmd(founder.actor, {
          listingId: slot.listingId,
          expectedRevision: 1,
          guildId: 'synthetic-guild',
          terms: { ...raidTerms(), admission: 'APPLICATION', title: 'Edited with no applicants' },
        }),
        founderHost,
      ),
    );
    expect(
      await db.$queryRawUnsafe(
        `SELECT 1 FROM "AuditEvent" WHERE "eventType"='work.offers_revoked.v1'`,
      ),
    ).toEqual([]);
  });
  it('reports a revoked offer as unavailable (an elapsed one is covered by the expiry test)', async () => {
    const { applicant, founder, slot, apply } = await setup();
    const a = await applyTo(apply);
    const o = await offerTo(
      cmd(founder.actor, { applicationId: a.application.id, expiresAt: expiry() }),
    );
    await run((tx) => revokeOffer(tx, cmd(founder.actor, { offerId: o.offer.id }), host));
    await expect(accept(applicant.actor, slot, o.offer.id)).rejects.toMatchObject({
      code: 'OFFER_UNAVAILABLE',
    });
  });
  it('indexes offers by application for history and restrict checks', async () => {
    const found = await db.$queryRawUnsafe(
      `SELECT 1 FROM pg_indexes WHERE "tablename"='RaidOffer' AND "indexdef" LIKE '%("applicationId")' AND "indexdef" NOT LIKE '%UNIQUE%'`,
    );
    expect(found).toHaveLength(1);
  });
  it('refuses a guild-authorised non-creator, a foreign applicant and an over-long or missing offer path', async () => {
    const { applicant, founder, slot, apply } = await setup();
    const other = await seedWorkHuman(db, 'founder-' + randomUUID());
    const stranger = await seedWorkHuman(db);
    const a = await applyTo(apply);
    await expect(
      offerTo(cmd(other.actor, { applicationId: a.application.id, expiresAt: expiry() })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [terms] = await db.$queryRawUnsafe<{ commitment: string }[]>(
      `SELECT "snapshot"->'deadlines'->>'commitment' AS commitment FROM "TermsVersion" WHERE "id"=$1::uuid`,
      slot.termsVersionId,
    );
    await expect(
      offerTo(
        cmd(founder.actor, {
          applicationId: a.application.id,
          expiresAt: new Date(Date.parse(terms.commitment) + 60000).toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const o = await offerTo(
      cmd(founder.actor, { applicationId: a.application.id, expiresAt: expiry() }),
    );
    await expect(
      run((tx) => revokeOffer(tx, cmd(other.actor, { offerId: o.offer.id }), host)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      run((tx) =>
        withdrawApplication(tx, cmd(stranger.actor, { applicationId: a.application.id }), host),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      run((tx) =>
        commitEngagement(
          tx,
          cmd(applicant.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
          syntheticAcceptanceHost,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ADMISSION_REQUIRED' });
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "RaidOffer" ("applicationId","slotId","termsVersionId","participantId","offeredByAccountId","expiresAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,clock_timestamp()+interval '1 hour')`,
        a.application.id,
        slot.slotId,
        slot.termsVersionId,
        applicant.participantId,
        other.actor.accountId,
      ),
    ).rejects.toThrow(/Invalid exact-source Founder offer|duplicate key/);
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
