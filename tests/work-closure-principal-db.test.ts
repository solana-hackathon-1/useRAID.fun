import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import {
  closeOverdueEngagement,
  closeOverdueEngagementAsPrincipal,
} from '../src/work-loop/closure-storage';
import { closeOverdueBatch } from '../src/work-loop/closure-pass';
import { WORK_CLOSURE_PRINCIPAL, type ClosureHost } from '../src/work-loop/closure-contracts';
import { createRootClosureHost } from '../src/lib/work-closure-host';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

// DEC-2026-11-14-08 (#352 item 5): worker closes act as the `work-closure` service principal, which is not a User row.
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const untilPast = (instant: string) =>
  db.$queryRawUnsafe(
    `SELECT pg_sleep(GREATEST(0, extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)::text AS slept`,
    instant,
  );
const row = async <T>(sql: string, ...args: string[]) =>
  (await db.$queryRawUnsafe(sql, ...args)) as T[];
const key = () => randomUUID();
const principalCommand = (input: unknown, k = key()) => ({
  principal: WORK_CLOSURE_PRINCIPAL,
  input,
  idempotencyKey: k,
  requestId: k,
});
const humanCommand = (actor: { accountId: string; sessionHash: string }, input: unknown) => ({
  actor,
  input,
  idempotencyKey: key(),
  requestId: key(),
});
const allow: ClosureHost = { allowNewWrites: true, authorize: async () => true };
const closers = (engagementId: string) =>
  row<{ account: string | null; principal: string | null; reason: string }>(
    'SELECT "closedByAccountId" AS account,"closedByPrincipal" AS principal,"reason" FROM "EngagementClosure" WHERE "engagementId"=$1::uuid',
    engagementId,
  );
const deadlines = () => ({
  commitment: at(3000),
  preparation: at(3500),
  submission: at(4000),
  review: at(4500),
  operationalClosure: at(5000),
});
async function setup() {
  const worker = await seedWorkHuman(db);
  const reviewer = await seedWorkHuman(db, 'reviewer-' + randomUUID());
  const d = deadlines();
  const slot = await seedWorkSlot(db, undefined, {
    review: { ...raidTerms().review, reviewerAccountId: reviewer.actor.accountId },
    deadlines: d,
  });
  const accepted = await run((tx) =>
    commitEngagement(
      tx,
      {
        actor: worker.actor,
        input: { slotId: slot.slotId, termsVersionId: slot.termsVersionId },
        idempotencyKey: key(),
        requestId: key(),
      },
      syntheticAcceptanceHost,
    ),
  );
  return { engagementId: accepted.engagement.id, due: d.operationalClosure };
}
const revision = async (id: string) =>
  (
    await row<{ revision: number }>('SELECT "revision" FROM "Engagement" WHERE "id"=$1::uuid', id)
  )[0].revision;

integration('DEC-2026-11-14-08 work-closure service principal', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());

  it('records the principal, not an account, for a worker pass that needs no User, Session or allowlist', async () => {
    const a = await setup();
    await untilPast(a.due);
    const pass = await closeOverdueBatch({
      run: (work) => runCommandTransaction(db, work),
      host: createRootClosureHost(true, () => false),
    });
    expect(pass).toMatchObject({ considered: 1, closed: 1, failed: [] });
    expect(await closers(a.engagementId)).toEqual([
      { account: null, principal: 'work-closure', reason: 'ACCESS_TIMEOUT' },
    ]);
    // The principal is not an identity: no User, Session, wallet or X link, Participant or capacity bears its name.
    for (const [table, column] of [
      ['User', 'id'],
      ['Session', 'userId'],
      ['Participant', 'accountId'],
    ])
      expect(await row(`SELECT 1 FROM "${table}" WHERE "${column}"='work-closure'`), table).toEqual(
        [],
      );
    // The worker's receipts are its own, under the principal name only.
    const receipts = await row<{ actorId: string }>(
      `SELECT DISTINCT "actorId" FROM "CommandReceipt" WHERE "commandKind"='CloseOverdueEngagement'`,
    );
    expect(receipts).toEqual([{ actorId: 'work-closure' }]);
  }, 40000);

  it('records the human account for a manual close and still requires that operator session', async () => {
    const a = await setup();
    const ops = await seedWorkHuman(db, 'ops-' + randomUUID());
    await untilPast(a.due);
    const input = {
      engagementId: a.engagementId,
      expectedRevision: await revision(a.engagementId),
    };
    // The principal's name is not an account: presented as one it has no Session and is refused.
    await expect(
      run((tx) =>
        closeOverdueEngagement(
          tx,
          humanCommand({ accountId: 'work-closure', sessionHash: 'a'.repeat(64) }, input),
          allow,
        ),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await closers(a.engagementId)).toEqual([]);
    await run((tx) => closeOverdueEngagement(tx, humanCommand(ops.actor, input), allow));
    expect(await closers(a.engagementId)).toEqual([
      { account: ops.actor.accountId, principal: null, reason: 'ACCESS_TIMEOUT' },
    ]);
  }, 40000);

  it('lets the principal close only overdue work, under the switch and the host, never early, and refuses any other principal name', async () => {
    const a = await setup();
    const input = {
      engagementId: a.engagementId,
      expectedRevision: await revision(a.engagementId),
    };
    const asPrincipal = (host: ClosureHost, i: unknown = input) =>
      run((tx) => closeOverdueEngagementAsPrincipal(tx, principalCommand(i), host));
    await expect(asPrincipal(allow)).rejects.toMatchObject({ code: 'DEADLINE_NOT_REACHED' });
    await untilPast(a.due);
    await expect(asPrincipal({ ...allow, allowNewWrites: false })).rejects.toMatchObject({
      code: 'WRITES_DISABLED',
    });
    await expect(asPrincipal({ ...allow, authorize: async () => false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(asPrincipal(allow, { ...input, extra: 1 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      run((tx) =>
        closeOverdueEngagementAsPrincipal(
          tx,
          { ...principalCommand(input), principal: 'someone-else' as never },
          allow,
        ),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await closers(a.engagementId)).toEqual([]);
    // The Root host authorizes the principal itself and nothing about it depends on the operator allowlist.
    const root = createRootClosureHost(true, () => false);
    const replayKey = key();
    const first = await run((tx) =>
      closeOverdueEngagementAsPrincipal(tx, principalCommand(input, replayKey), root),
    );
    expect(first.status).toBe('EXECUTED');
    const again = await run((tx) =>
      closeOverdueEngagementAsPrincipal(tx, principalCommand(input, replayKey), root),
    );
    expect(again).toMatchObject({ status: 'REPLAYED', closure: first.closure });
  }, 40000);

  it('refuses a non-operator human at the Root host, even when the presented actor also carries a principal key', async () => {
    const a = await setup();
    const stranger = await seedWorkHuman(db, 'stranger-' + randomUUID());
    const ops = await seedWorkHuman(db, 'ops-' + randomUUID());
    await untilPast(a.due);
    const input = {
      engagementId: a.engagementId,
      expectedRevision: await revision(a.engagementId),
    };
    const root = createRootClosureHost(true, (id) => id === ops.actor.accountId);
    const manual = (actor: object) =>
      run((tx) => closeOverdueEngagement(tx, humanCommand(actor as never, input), root));
    await expect(manual(stranger.actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A real session spoofed with the principal key is still just that human: not an operator, so refused.
    await expect(
      manual({ ...stranger.actor, principal: WORK_CLOSURE_PRINCIPAL }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await closers(a.engagementId)).toEqual([]);
    // An operator carrying the extra key is still recorded as the account, never as the principal.
    await manual({ ...ops.actor, principal: WORK_CLOSURE_PRINCIPAL });
    expect(await closers(a.engagementId)).toEqual([
      { account: ops.actor.accountId, principal: null, reason: 'ACCESS_TIMEOUT' },
    ]);
  }, 40000);

  it('refuses at the database both-or-neither closers, an unknown principal and a principal acceptance', async () => {
    const a = await setup();
    const ops = await seedWorkHuman(db, 'ops-' + randomUUID());
    await untilPast(a.due);
    const attempt = (columns: string, values: unknown[]) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "EngagementClosure" ("engagementId","reason","finalState"${columns}) VALUES ($1::uuid,'ACCESS_TIMEOUT','TERMINATED'${values.map((_, i) => `,$${i + 2}`).join('')})`,
          a.engagementId,
          ...values,
        );
        throw Error('rolled back after the statement was accepted');
      });
    await expect(attempt('', [])).rejects.toThrow(/EngagementClosure_closer_check/);
    await expect(
      attempt(',"closedByAccountId","closedByPrincipal"', [ops.actor.accountId, 'work-closure']),
    ).rejects.toThrow(/EngagementClosure_closer_check/);
    await expect(attempt(',"closedByPrincipal"', ['someone-else'])).rejects.toThrow(
      /EngagementClosure_principal_check/,
    );
    // A principal can never record an acceptance, which needs the independent reviewer.
    // (Triggers are skipped for this one crafted write only, so the table CHECK is what refuses it.)
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRawUnsafe(
          `INSERT INTO "EngagementClosure" ("engagementId","reason","finalState","closedByPrincipal") VALUES ($1::uuid,'ACCEPTED','ACCEPTED','work-closure')`,
          a.engagementId,
        );
      }),
    ).rejects.toThrow(/EngagementClosure_principal_check/);
    // Both well-formed shapes are accepted and each rolls back here.
    await expect(attempt(',"closedByPrincipal"', ['work-closure'])).rejects.toThrow(/rolled back/);
    await expect(attempt(',"closedByAccountId"', [ops.actor.accountId])).rejects.toThrow(
      /rolled back/,
    );
  }, 40000);

  it('keeps the principal name out of the User table, so it can never become an account', async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "User" ("id","handle") VALUES ('work-closure','work-closure')`,
      ),
    ).rejects.toThrow(/User_service_principal_check/);
  });
});
