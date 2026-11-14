import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import {
  recordAcceptanceConsent,
  withdrawAcceptanceConsent,
} from '../src/work-loop/consent-storage';
import type { AcceptanceHost } from '../src/work-loop/engagement-contracts';
import { createRootAcceptanceHost } from '../src/lib/work-acceptance-host';
import { seedWorkHuman, seedWorkSlot } from './helpers/work-loop-db';
import { seedOwnAssessmentFixture, db } from './helpers/own-assessment-fixture';
import { assertTestDatabase } from './helpers/db-guard';
import { matchesBlockingObservation } from './helpers/lock-observation';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work, { transaction: { timeout: 20000, maxWait: 20000 } });
type Actor = { accountId: string; sessionHash: string };
const cmd = (actor: Actor, input: unknown, key: string = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: key,
});
const host = (): AcceptanceHost =>
  createRootAcceptanceHost({
    taxonomyId: 'synthetic-submission-catalog',
    allowNewWrites: true,
    isOperator: () => false,
  });
const rows = <T>(sql: string, ...args: string[]) =>
  db.$queryRawUnsafe(sql, ...args) as Promise<T[]>;
const sqlState = (error: unknown) => {
  const source = error as { code?: string; meta?: { code?: string } };
  return source.code === 'P2010' ? source.meta?.code : source.code;
};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function waitFor(blocker: number, statement: RegExp) {
  const until = Date.now() + 8000;
  let last: unknown;
  while (Date.now() < until) {
    const waiting = await rows<{ query: string; blockers: number[] }>(
      `SELECT query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`,
    );
    last = waiting;
    if (waiting.some((row) => matchesBlockingObservation(row, blocker, statement))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(
    'Expected database blocking relationship was not observed: ' + blocker + JSON.stringify(last),
  );
}
let person: Actor;
async function setup() {
  const fx = await seedOwnAssessmentFixture(true);
  person = { accountId: fx.ownerId, sessionHash: fx.cookieHash };
  const [version] = await rows<{ id: string }>(
    'SELECT "policyVersionId"::text AS id FROM "SkillAssessmentVersion" LIMIT 1',
  );
  const slot = await seedWorkSlot(db as never, undefined, {
    requiredSkills: [
      { skillId: 'frontend', minimumRank: 'D', assessmentPolicyVersion: version.id },
    ] as never,
  });
  const [terms] = await rows<{ digest: string }>(
    'SELECT "digest" FROM "TermsVersion" WHERE "id"=$1::uuid',
    slot.termsVersionId,
  );
  return { slot, digest: terms.digest };
}
type Slot = Awaited<ReturnType<typeof setup>>['slot'];
const consent = (actor: Actor, slot: Slot, digest: string) =>
  run((tx) =>
    recordAcceptanceConsent(
      tx,
      cmd(actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId, termsDigest: digest }),
      { allowNewWrites: true },
    ),
  );
const accept = (actor: Actor, slot: Slot, h: AcceptanceHost = host()) =>
  run((tx) =>
    commitEngagement(
      tx,
      cmd(actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      h,
    ),
  );
const withdraw = (actor: Actor, consentId: string, key?: string) =>
  run((tx) => withdrawAcceptanceConsent(tx, cmd(actor, { consentId }, key)));
const count = async (table: string) =>
  (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`))[0].n;

integration(
  'Withdrawing an unused acceptance consent (DEC-2026-11-14-07, #275-4)',
  { timeout: 120000 },
  () => {
    beforeEach(() => assertTestDatabase());
    afterAll(() => db.$disconnect());

    it('refuses acceptance on a withdrawn consent, replays the withdrawal, and keeps the consent row itself', async () => {
      const { slot, digest } = await setup();
      const saved = await consent(person, slot, digest);
      const key = randomUUID();
      const first = await withdraw(person, saved.consent.id, key);
      expect(first.status).toBe('EXECUTED');
      expect(first.withdrawal.consentId).toBe(saved.consent.id);
      // The same key replays the recorded answer; a new key finds it already withdrawn, and nothing is recorded twice.
      const replay = await withdraw(person, saved.consent.id, key);
      expect(replay.status).toBe('REPLAYED');
      expect(replay.withdrawal.id).toBe(first.withdrawal.id);
      await expect(withdraw(person, saved.consent.id)).rejects.toMatchObject({
        code: 'CONSENT_WITHDRAWN',
      });
      expect(await count('WorkAcceptanceConsentWithdrawal')).toBe(1);
      expect(await count('WorkAcceptanceConsent')).toBe(1);
      await expect(accept(person, slot)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
      expect(await count('Engagement')).toBe(0);
      // A withdrawn consent is not silently revived by recording it again.
      await expect(consent(person, slot, digest)).rejects.toMatchObject({
        code: 'CONSENT_WITHDRAWN',
      });
    });

    it('refuses to withdraw a consent an engagement already used, and writes nothing', async () => {
      const { slot, digest } = await setup();
      const saved = await consent(person, slot, digest);
      const accepted = await accept(person, slot);
      expect(accepted.engagement.acceptedTerms.roster[0].consentRef).toBe(saved.consent.id);
      await expect(withdraw(person, saved.consent.id)).rejects.toMatchObject({
        code: 'CONSENT_USED',
      });
      expect(await count('WorkAcceptanceConsentWithdrawal')).toBe(0);
      // Withdrawal changes no accepted engagement and releases no capacity.
      expect(await rows('SELECT 1 FROM "ActiveCommitment"')).toHaveLength(1);
      expect((await rows<{ state: string }>('SELECT "state" FROM "Engagement"'))[0].state).toBe(
        'ACCESS_PENDING',
      );
    });

    it('lets only the consenting, signed-in, unsuspended participant withdraw', async () => {
      const { slot, digest } = await setup();
      const saved = await consent(person, slot, digest);
      const stranger = await seedWorkHuman(db as never);
      // Someone else's consent is indistinguishable from a missing one.
      await expect(withdraw(stranger.actor, saved.consent.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(withdraw(stranger.actor, randomUUID())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        withdraw({ ...person, sessionHash: 'e'.repeat(64) }, saved.consent.id),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      await db.$executeRawUnsafe(
        'UPDATE "User" SET "suspended"=true WHERE "id"=$1',
        person.accountId,
      );
      await expect(withdraw(person, saved.consent.id)).rejects.toMatchObject({
        code: 'ACCOUNT_RESTRICTED',
      });
      expect(await count('WorkAcceptanceConsentWithdrawal')).toBe(0);
    });

    it('is enforced by the database for writers outside the command', async () => {
      const { slot, digest } = await setup();
      const saved = await consent(person, slot, digest);
      const other = await seedWorkHuman(db as never);
      const insert = (consentId: string, participantId: string) =>
        db
          .$executeRawUnsafe(
            'INSERT INTO "WorkAcceptanceConsentWithdrawal" ("consentId","participantId") VALUES ($1::uuid,$2::uuid)',
            consentId,
            participantId,
          )
          .then(
            () => 'inserted',
            (error) => sqlState(error),
          );
      const [owner] = await rows<{ id: string }>(
        'SELECT "id"::text FROM "Participant" WHERE "accountId"=$1',
        person.accountId,
      );
      // Not the consenter, and a consent that does not exist.
      expect(await insert(saved.consent.id, other.participantId)).toBe('23514');
      expect(await insert(randomUUID(), owner.id)).toBe('23503');
      // Used consent.
      await accept(person, slot);
      expect(await insert(saved.consent.id, owner.id)).toBe('23514');
      expect(await count('WorkAcceptanceConsentWithdrawal')).toBe(0);
    });

    it('keeps withdrawals append-only', async () => {
      const { slot, digest } = await setup();
      const saved = await consent(person, slot, digest);
      await withdraw(person, saved.consent.id);
      for (const sql of [
        'UPDATE "WorkAcceptanceConsentWithdrawal" SET "withdrawnAt"=now()',
        'DELETE FROM "WorkAcceptanceConsentWithdrawal"',
      ])
        expect(await db.$executeRawUnsafe(sql).catch(sqlState)).toBe('23514');
      expect(await count('WorkAcceptanceConsentWithdrawal')).toBe(1);
    });

    it('serializes on the consent row: an acceptance that holds it wins, and the waiting withdrawal sees CONSENT_USED', async () => {
      const { slot, digest } = await setup();
      const saved = await consent(person, slot, digest);
      const holding = deferred<number>(),
        release = deferred();
      const real = host();
      const gated: AcceptanceHost = {
        ...real,
        assess: async (tx, ctx) => {
          const approval = await real.assess(tx, ctx);
          const [pid] = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', []);
          holding.resolve(pid.pid);
          await release.promise;
          return approval;
        },
      };
      const accepting = accept(person, slot, gated);
      accepting.catch(() => undefined);
      const blocker = await holding.promise;
      const withdrawing = withdraw(person, saved.consent.id);
      withdrawing.catch(() => undefined);
      try {
        // The same person's commands already queue on their identity rows; the withdrawal is held behind the acceptance
        // either way and must not complete (or report the consent unused) before the engagement commits.
        await waitFor(blocker, /FOR (SHARE|UPDATE)/);
      } finally {
        release.resolve();
      }
      expect((await accepting).engagement.state).toBe('ACCESS_PENDING');
      await expect(withdrawing).rejects.toMatchObject({ code: 'CONSENT_USED' });
      expect(await count('WorkAcceptanceConsentWithdrawal')).toBe(0);
      expect(await count('Engagement')).toBe(1);
    });

    it('serializes on the consent row: a withdrawal that holds it wins, and the waiting acceptance never uses the consent', async () => {
      const { slot, digest } = await setup();
      const saved = await consent(person, slot, digest);
      const [owner] = await rows<{ id: string }>(
        'SELECT "id"::text FROM "Participant" WHERE "accountId"=$1',
        person.accountId,
      );
      const inserted = deferred<number>(),
        release = deferred();
      // The withdrawal, uncommitted: its guard has taken the consent row FOR UPDATE.
      const withdrawing = db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'INSERT INTO "WorkAcceptanceConsentWithdrawal" ("consentId","participantId") VALUES ($1::uuid,$2::uuid)',
            saved.consent.id,
            owner.id,
          );
          const [pid] = await tx.$queryRawUnsafe<{ pid: number }[]>(
            'SELECT pg_backend_pid() AS pid',
          );
          inserted.resolve(pid.pid);
          await release.promise;
        },
        { timeout: 20000, maxWait: 20000 },
      );
      withdrawing.catch(() => undefined);
      const blocker = await inserted.promise;
      const accepting = accept(person, slot);
      accepting.catch(() => undefined);
      try {
        await waitFor(blocker, /"WorkAcceptanceConsent"/);
      } finally {
        release.resolve();
      }
      await withdrawing;
      await expect(accepting).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
      expect(await count('Engagement')).toBe(0);
      expect(await count('WorkAcceptanceConsentWithdrawal')).toBe(1);
    });

    it('refuses, in the database, an engagement that names a withdrawn consent', async () => {
      const { slot, digest } = await setup();
      const saved = await consent(person, slot, digest);
      // A host that ignores the withdrawal (a stale approval) still cannot commit an engagement on it.
      const stale: AcceptanceHost = {
        ...host(),
        assess: async (tx, ctx) => {
          const approval = await host().assess(tx, ctx);
          await tx.query(
            'INSERT INTO "WorkAcceptanceConsentWithdrawal" ("consentId","participantId") VALUES ($1::uuid,$2::uuid)',
            [saved.consent.id, ctx.participantId],
          );
          return approval;
        },
      };
      await expect(accept(person, slot, stale)).rejects.toBeTruthy();
      expect(await count('Engagement')).toBe(0);
    });

    it('never leaves both an engagement and a withdrawal for one consent when the two race unsynchronized', async () => {
      for (let round = 0; round < 6; round++) {
        const { slot, digest } = await setup();
        const saved = await consent(person, slot, digest);
        const outcomes = await Promise.allSettled([
          accept(person, slot),
          withdraw(person, saved.consent.id),
        ]);
        const engagements = await count('Engagement'),
          withdrawals = await count('WorkAcceptanceConsentWithdrawal');
        expect(engagements + withdrawals).toBe(1);
        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
        const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
        expect(loser.reason.code).toBe(engagements ? 'CONSENT_USED' : 'CONSENT_REQUIRED');
      }
    });
  },
);
