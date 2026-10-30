import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { submitWork } from '../src/work-loop/submission-storage';
import { canonicalRequestDigest } from '../src/command-receipts';
import { createAmendmentHandlers } from '../src/work-http/amendment-http';
import {
  proposeAmendmentFromHost,
  respondToAmendmentFromHost,
  withdrawAmendmentFromHost,
  readAmendmentDeskFromHost,
} from '../src/lib/work-amendment-host';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const gate = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
type Actor = { accountId: string; sessionHash: string };
/** The same handlers the route files compose, with the cookie actor fixed per caller so concurrent calls cannot swap. */
const forActor = new Map<string, ReturnType<typeof createAmendmentHandlers>>();
function handlersFor(actor: Actor) {
  let h = forActor.get(actor.accountId);
  if (!h)
    forActor.set(
      actor.accountId,
      (h = createAmendmentHandlers({
        version: 'v1',
        requestId: randomUUID,
        actor: async () => actor,
        checkOrigin: () => {},
        rateLimit: () => {},
        desk: readAmendmentDeskFromHost,
        propose: proposeAmendmentFromHost,
        respond: respondToAmendmentFromHost,
        withdraw: withdrawAmendmentFromHost,
      })),
    );
  return h;
}
const base = raidTerms();
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const post = (body: unknown, key: string = randomUUID()) =>
  new Request('http://localhost/api/v1/work/amendments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
const get = () => new Request('http://localhost/api/v1/work/amendments', { method: 'GET' });
const propose = (actor: Actor, engagementId: string, changes: unknown, key?: string) =>
  handlersFor(actor).PROPOSE(post({ engagementId, changes, expiresAt: at(3600000) }, key));
const proposeFixed = (actor: Actor, body: unknown, key: string) =>
  handlersFor(actor).PROPOSE(post(body, key));
const accept = (actor: Actor, id: string, digest: string, key?: string) =>
  handlersFor(actor).RESPOND(post({ decision: 'ACCEPT', digest }, key), id);
const decline = (actor: Actor, id: string, key?: string) =>
  handlersFor(actor).RESPOND(post({ decision: 'DECLINE' }, key), id);
const withdraw = (actor: Actor, id: string, key?: string) =>
  handlersFor(actor).WITHDRAW(post({}, key), id);
const desk = (actor: Actor) => handlersFor(actor).DESK(get());
const code = async (r: Response) => (await r.json()).error.code as string;
const row = async <T>(sql: string, ...args: string[]) =>
  (await db.$queryRawUnsafe(sql, ...args)) as T[];
const raise = { rewards: [{ amount: '1500000000' }] };
const cut = { rewards: [{ amount: '500000000' }] };
const cmd = (actor: Actor, input: unknown) => ({
  actor,
  input,
  idempotencyKey: randomUUID(),
  requestId: randomUUID(),
});
async function setup() {
  const founder = await seedWorkHuman(db, 'founder-' + randomUUID());
  const worker = await seedWorkHuman(db);
  const reviewer = await seedWorkHuman(db, 'reviewer-' + randomUUID());
  const slot = await seedWorkSlot(db, founder.actor.accountId, {
    review: { ...base.review, reviewerAccountId: reviewer.actor.accountId },
  });
  const accepted = await run((tx) =>
    commitEngagement(
      tx,
      cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      syntheticAcceptanceHost,
    ),
  );
  operators.add(founder.actor.accountId);
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', [...operators].join(','));
  return { founder, worker, engagementId: accepted.engagement.id };
}
const operators = new Set<string>();
const amendments = () =>
  row<{
    id: string;
    state: string;
    consentRef: string | null;
    additionalFundingRef: string | null;
  }>(
    'SELECT "id"::text,"state","consentRef","additionalFundingRef" FROM "EngagementAmendment" ORDER BY "createdAt"',
  );
const effectiveAmount = async (engagementId: string) =>
  (
    await row<{ amount: string }>(
      `SELECT raid_effective_terms("id")->'rewards'->0->>'amount' AS amount FROM "Engagement" WHERE "id"=$1::uuid`,
      engagementId,
    )
  )[0].amount;
const start = (engagementId: string) =>
  db.$executeRawUnsafe(
    `UPDATE "Engagement" SET "state"='IN_PROGRESS',"revision"="revision"+1 WHERE "id"=$1::uuid`,
    engagementId,
  );
/**
 * Holds the engagement row lock in another connection, lets `fire` start its requests, waits until that many backends
 * are blocked on a lock, then releases: the requests then race for the lock in one commit-ordered burst.
 */
async function barrier<T>(engagementId: string, waiters: number, fire: () => Promise<T>[]) {
  let pending: Promise<T>[] = [];
  await gate.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT 1 FROM "Engagement" WHERE "id"=$1::uuid FOR UPDATE',
        engagementId,
      );
      pending = fire();
      for (let i = 0; i < 200; i++) {
        // Activity statistics are snapshotted per transaction, so observe from outside the gate transaction.
        const blocked = (await db.$queryRawUnsafe(
          `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`,
        )) as unknown[];
        if (blocked.length >= waiters) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('requests never blocked on the engagement lock');
    },
    { timeout: 30000 },
  );
  return Promise.all(pending);
}

integration(
  'T025 root composition: amendment HTTP over real PostgreSQL',
  { timeout: 60000 },
  () => {
    beforeEach(async () => {
      assertTestDatabase();
      await truncateAll(db);
      operators.clear();
      vi.stubEnv('WORK_AMENDMENTS_ENABLED', 'true');
      vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', 'true');
      vi.stubEnv(
        'WORK_REWARD_ASSETS_JSON',
        JSON.stringify([{ label: 'SOL', policy: base.rewards[0].policy, funded: true }]),
      );
    });
    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
      await gate.$disconnect();
      await db.$disconnect();
    });

    it('keeps the accepted terms until the member consents to the exact version, then versions them', async () => {
      const { founder, worker, engagementId } = await setup();
      await start(engagementId);
      const before = await row<{ acceptedDigest: string }>(
        'SELECT "acceptedDigest" FROM "Engagement" WHERE "id"=$1::uuid',
        engagementId,
      );
      const proposed = await propose(founder.actor, engagementId, raise);
      expect(proposed.status).toBe(200);
      const { amendment } = await proposed.json();
      expect(amendment).toMatchObject({ state: 'PROPOSED', requiresFunding: true });
      expect(canonicalRequestDigest(amendment.terms)).toBe(amendment.digest);
      expect(await effectiveAmount(engagementId)).toBe('1000000000');
      // Both sides see the proposal and the unchanged promise.
      const memberView = await (await desk(worker.actor)).json();
      expect(memberView.proposalsAvailable).toBe(true);
      expect(memberView.engagements).toHaveLength(1);
      expect(memberView.engagements[0]).toMatchObject({ role: 'MEMBER', engagementId });
      expect(memberView.engagements[0].effectiveTerms.rewards[0].amount).toBe('1000000000');
      expect(memberView.engagements[0].amendments[0].id).toBe(amendment.id);
      const founderView = await (await desk(founder.actor)).json();
      expect(founderView.engagements[0]).toMatchObject({ role: 'FOUNDER', engagementId });
      expect(founderView.engagements[0].effectiveTerms.rewards[0].amount).toBe('1000000000');
      // Consent to a different version, or none, is refused and writes nothing.
      const wrong = await accept(worker.actor, amendment.id, 'f'.repeat(64));
      expect(wrong.status).toBe(409);
      expect(await code(wrong)).toBe('CONSENT_REQUIRED');
      expect((await amendments())[0].state).toBe('PROPOSED');
      const agreed = await accept(worker.actor, amendment.id, amendment.digest);
      expect(agreed.status).toBe(200);
      expect((await agreed.json()).amendment.state).toBe('ACCEPTED');
      expect(await effectiveAmount(engagementId)).toBe('1500000000');
      // Original accepted history is retained and the stored consent names the exact digest.
      expect(
        (
          await row<{ acceptedDigest: string }>(
            'SELECT "acceptedDigest" FROM "Engagement" WHERE "id"=$1::uuid',
            engagementId,
          )
        )[0],
      ).toEqual(before[0]);
      const [stored] = await amendments();
      expect(stored.consentRef).toBe(
        `root-amendment-consent:${worker.participantId}:${amendment.digest}`,
      );
      expect(stored.additionalFundingRef).toBe('sim-amendment-reservation:' + amendment.id);
      // The member's capacity is untouched by an amendment.
      expect(await row('SELECT 1 FROM "ActiveCommitment"')).toHaveLength(1);
      const after = await (await desk(worker.actor)).json();
      expect(after.engagements[0].effectiveTerms.rewards[0].amount).toBe('1500000000');
    });

    it('reports FUNDING_NOT_VERIFIED for an uncovered increase and writes nothing; a decrease needs no funding', async () => {
      const { founder, worker, engagementId } = await setup();
      vi.stubEnv(
        'WORK_REWARD_ASSETS_JSON',
        JSON.stringify([{ label: 'SOL', policy: base.rewards[0].policy, funded: false }]),
      );
      const refused = await propose(founder.actor, engagementId, raise);
      expect(refused.status).toBe(409);
      expect(await code(refused)).toBe('FUNDING_NOT_VERIFIED');
      expect(await amendments()).toEqual([]);
      vi.stubEnv('WORK_REWARD_ASSETS_JSON', '');
      expect(await code(await propose(founder.actor, engagementId, raise))).toBe(
        'FUNDING_NOT_VERIFIED',
      );
      const lower = await propose(founder.actor, engagementId, cut);
      expect(lower.status).toBe(200);
      const { amendment } = await lower.json();
      expect(amendment.requiresFunding).toBe(false);
      expect((await accept(worker.actor, amendment.id, amendment.digest)).status).toBe(200);
      expect(await effectiveAmount(engagementId)).toBe('500000000');
    });

    it('rejects every unilateral or foreign actor and never crosses engagements', async () => {
      const a = await setup();
      const b = await setup();
      const stranger = await seedWorkHuman(db, 'stranger-' + randomUUID());
      const otherOperator = await seedWorkHuman(db, 'founder-' + randomUUID());
      operators.add(otherOperator.actor.accountId);
      vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', [...operators].join(','));
      // Not on the allowlist, not the listing's creator, or the engagement's own member: all one FORBIDDEN.
      for (const actor of [stranger.actor, otherOperator.actor, a.worker.actor, b.founder.actor]) {
        const r = await propose(actor, a.engagementId, raise);
        expect([r.status, await code(r)]).toEqual([403, 'FORBIDDEN']);
      }
      expect(await amendments()).toEqual([]);
      const made = await (await propose(a.founder.actor, a.engagementId, raise)).json();
      const id = made.amendment.id as string;
      const digest = made.amendment.digest as string;
      // Strangers, another engagement's member and the Founder cannot consent: indistinguishable from missing.
      for (const actor of [stranger.actor, b.worker.actor, a.founder.actor]) {
        const r = await accept(actor, id, digest);
        expect([r.status, await code(r)]).toEqual([404, 'NOT_FOUND']);
        const d = await decline(actor, id);
        expect(d.status).toBe(404);
      }
      // Only the proposer withdraws.
      for (const actor of [stranger.actor, a.worker.actor, b.founder.actor, otherOperator.actor]) {
        const r = await withdraw(actor, id);
        expect([r.status, await code(r)]).toEqual([403, 'FORBIDDEN']);
      }
      expect((await amendments())[0].state).toBe('PROPOSED');
      // Desk reads are scoped to the caller.
      expect((await (await desk(stranger.actor)).json()).engagements).toEqual([]);
      const other = await (await desk(b.worker.actor)).json();
      expect(other.engagements).toHaveLength(1);
      expect(other.engagements[0].engagementId).toBe(b.engagementId);
      expect(other.engagements[0].amendments).toEqual([]);
      // The Founder of engagement B is not Founder of A.
      const bFounder = await (await desk(b.founder.actor)).json();
      expect(bFounder.engagements.map((e: { engagementId: string }) => e.engagementId)).toEqual([
        b.engagementId,
      ]);
    });

    it('refuses writes when the flag is off but still answers replays and reads', async () => {
      const { founder, worker, engagementId } = await setup();
      const key = randomUUID();
      const body = { engagementId, changes: raise, expiresAt: at(3600000) };
      const first = await proposeFixed(founder.actor, body, key);
      const { amendment } = await first.json();
      const acceptKey = randomUUID();
      expect((await accept(worker.actor, amendment.id, amendment.digest, acceptKey)).status).toBe(
        200,
      );
      vi.stubEnv('WORK_AMENDMENTS_ENABLED', '');
      // New commands are refused with the settled "not available" answer and write nothing.
      const refused = await propose(founder.actor, engagementId, cut);
      expect([refused.status, await code(refused)]).toEqual([503, 'NOT_AVAILABLE']);
      expect(await amendments()).toHaveLength(1);
      // The original commands replay even though the proposal has since been accepted and the flag is off.
      const replay = await proposeFixed(founder.actor, body, key);
      expect(replay.status).toBe(200);
      const replayed = await replay.json();
      expect(replayed.status).toBe('REPLAYED');
      expect(replayed.amendment.id).toBe(amendment.id);
      const again = await accept(worker.actor, amendment.id, amendment.digest, acceptKey);
      expect(again.status).toBe(200);
      expect((await again.json()).status).toBe('REPLAYED');
      const view = await (await desk(worker.actor)).json();
      expect(view.proposalsAvailable).toBe(false);
      expect(view.engagements[0].amendments[0].state).toBe('ACCEPTED');
      // Reads also need the workspace read switch; closed, the desk is unavailable.
      vi.stubEnv('WORK_WORKSPACE_READS_ENABLED', '');
      expect((await desk(worker.actor)).status).toBe(503);
    });

    it('answers replays, reused keys, repeat decisions and a second open proposal honestly', async () => {
      const { founder, worker, engagementId } = await setup();
      const key = randomUUID();
      const body = { engagementId, changes: raise, expiresAt: at(3600000) };
      const one = await (await proposeFixed(founder.actor, body, key)).json();
      const two = await (await proposeFixed(founder.actor, body, key)).json();
      expect([one.status, two.status]).toEqual(['EXECUTED', 'REPLAYED']);
      expect(two.amendment.id).toBe(one.amendment.id);
      expect(await amendments()).toHaveLength(1);
      // The same key for a different command is refused.
      const reused = await proposeFixed(founder.actor, { ...body, changes: cut }, key);
      expect([reused.status, await code(reused)]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
      // One open proposal at a time.
      const second = await propose(founder.actor, engagementId, cut);
      expect([second.status, await code(second)]).toEqual([409, 'REVISION_CHANGED']);
      const declinedKey = randomUUID();
      const declined = await decline(worker.actor, one.amendment.id, declinedKey);
      expect((await declined.json()).amendment.state).toBe('DECLINED');
      expect(await effectiveAmount(engagementId)).toBe('1000000000');
      // A repeat decision with a new key, a consent after a decline and a withdrawal of a decided proposal: no longer open.
      for (const r of [
        await decline(worker.actor, one.amendment.id),
        await accept(worker.actor, one.amendment.id, one.amendment.digest),
        await withdraw(founder.actor, one.amendment.id),
      ]) {
        expect([r.status, await code(r)]).toEqual([409, 'NO_LONGER_OPEN']);
      }
      // The original decline still replays after the state moved on.
      const replay = await decline(worker.actor, one.amendment.id, declinedKey);
      expect((await replay.json()).status).toBe('REPLAYED');
      // A withdrawn proposal replays as withdrawn and cannot be consented to.
      const next = await (await propose(founder.actor, engagementId, cut)).json();
      const wKey = randomUUID();
      expect(
        (await (await withdraw(founder.actor, next.amendment.id, wKey)).json()).amendment.state,
      ).toBe('WITHDRAWN');
      expect((await (await withdraw(founder.actor, next.amendment.id, wKey)).json()).status).toBe(
        'REPLAYED',
      );
      const late = await accept(worker.actor, next.amendment.id, next.amendment.digest);
      expect(await code(late)).toBe('NO_LONGER_OPEN');
      expect(await effectiveAmount(engagementId)).toBe('1000000000');
    });

    it('answers a stale engagement revision when the work has moved past an amendable state', async () => {
      const { founder, worker, engagementId } = await setup();
      await start(engagementId);
      const made = await (await propose(founder.actor, engagementId, raise)).json();
      await run((tx) =>
        submitWork(
          tx,
          cmd(worker.actor, {
            engagementId,
            expectedSubmissionNumber: 1,
            explanation: 'Guide written and verified on a clean machine.',
            artifacts: [
              {
                kind: 'COMMIT',
                ref: 'synthetic://repo/setup.md',
                immutableVersion: 'a'.repeat(40),
              },
            ],
            dependencies: [],
            aiUsage: null,
          }),
          { allowNewWrites: true },
        ),
      );
      const late = await accept(worker.actor, made.amendment.id, made.amendment.digest);
      expect([late.status, await code(late)]).toEqual([409, 'REVISION_CHANGED']);
      const refused = await propose(founder.actor, engagementId, cut);
      expect([refused.status, await code(refused)]).toEqual([409, 'REVISION_CHANGED']);
      expect(await effectiveAmount(engagementId)).toBe('1000000000');
      // Submitted work leaves the amendable desk.
      expect((await (await desk(worker.actor)).json()).engagements).toEqual([]);
    });

    it('serializes consent racing a withdrawal: exactly one wins and the loser is told it is no longer open', async () => {
      for (let round = 0; round < 3; round++) {
        const { founder, worker, engagementId } = await setup();
        const made = await (await propose(founder.actor, engagementId, raise)).json();
        const [consent, pulled] = await barrier(engagementId, 2, () => [
          accept(worker.actor, made.amendment.id, made.amendment.digest),
          withdraw(founder.actor, made.amendment.id),
        ]);
        const [row_] = (await amendments()).filter((r) => r.id === made.amendment.id);
        expect([consent.status, pulled.status].sort()).toEqual([200, 409]);
        if (row_.state === 'ACCEPTED') {
          expect(consent.status).toBe(200);
          expect(await code(pulled)).toBe('NO_LONGER_OPEN');
          expect(await effectiveAmount(engagementId)).toBe('1500000000');
        } else {
          expect(row_.state).toBe('WITHDRAWN');
          expect(await code(consent)).toBe('NO_LONGER_OPEN');
          expect(await effectiveAmount(engagementId)).toBe('1000000000');
        }
      }
    });

    it('serializes two proposals and duplicate requests under the same engagement lock', async () => {
      const { founder, worker, engagementId } = await setup();
      const [a, b] = await barrier(engagementId, 2, () => [
        propose(founder.actor, engagementId, raise),
        propose(founder.actor, engagementId, cut),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await amendments()).toHaveLength(1);
      const loser = a.status === 409 ? a : b;
      expect(await code(loser)).toBe('REVISION_CHANGED');
      const winner = await (a.status === 200 ? a : b).json();
      // The same consent sent twice at once (a double click) decides once and answers both.
      const key = randomUUID();
      const [x, y] = await barrier(engagementId, 2, () => [
        accept(worker.actor, winner.amendment.id, winner.amendment.digest, key),
        accept(worker.actor, winner.amendment.id, winner.amendment.digest, key),
      ]);
      expect([x.status, y.status]).toEqual([200, 200]);
      expect([(await x.json()).status, (await y.json()).status].sort()).toEqual([
        'EXECUTED',
        'REPLAYED',
      ]);
      expect((await amendments()).filter((r) => r.state === 'ACCEPTED')).toHaveLength(1);
      expect(
        await row('SELECT 1 FROM "AuditEvent" WHERE "eventType"=\'work.amendment_accepted.v1\''),
      ).toHaveLength(1);
    });

    it('fails the desk closed for an unauthenticated session-less actor and never lists others', async () => {
      const { worker } = await setup();
      const ghost = { accountId: worker.actor.accountId, sessionHash: '0'.repeat(64) };
      const r = await desk(ghost);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await r.json())).not.toContain('engagementId');
    });
  },
);
