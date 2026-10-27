import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { startEngagement } from '../src/work-loop/start-storage';
import { simulatedStartHost } from '../src/work-loop/start-simulated';
import type { StartHost } from '../src/work-loop/start-contracts';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const db = new PrismaClient();
const run = <T>(work: Parameters<typeof runCommandTransaction<T>>[1]) =>
  runCommandTransaction(db, work);
type Actor = { accountId: string; sessionHash: string };
const cmd = (actor: Actor, input: unknown, key: string = randomUUID()) => ({
  actor,
  input,
  idempotencyKey: key,
  requestId: key,
});
const day = 86400000;
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const ready: StartHost = {
  allowNewWrites: true,
  verifyBinding: async () => true,
  resourcesReady: async () => true,
};
async function setup(override: Partial<ReturnType<typeof raidTerms>> = {}) {
  const worker = await seedWorkHuman(db);
  const slot = await seedWorkSlot(db, undefined, override);
  const accepted = await run((tx) =>
    commitEngagement(
      tx,
      cmd(worker.actor, { slotId: slot.slotId, termsVersionId: slot.termsVersionId }),
      syntheticAcceptanceHost,
    ),
  );
  return { worker, slot, engagementId: accepted.engagement.id };
}
const start = (actor: Actor, engagementId: string, host: StartHost = ready, key?: string) =>
  run((tx) => startEngagement(tx, cmd(actor, { engagementId }, key), host));
const state = async (id: string) =>
  (
    (await db.$queryRawUnsafe(
      'SELECT "state","revision" FROM "Engagement" WHERE "id"=$1::uuid',
      id,
    )) as {
      state: string;
      revision: number;
    }[]
  )[0];
integration('T032 starting accepted work', { timeout: 60000 }, () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
  });
  afterAll(() => db.$disconnect());
  it('starts the member’s own pending engagement once binding and resources are ready, holding their capacity', async () => {
    const { worker, engagementId } = await setup();
    const before = await state(engagementId);
    expect(before.state).toBe('ACCESS_PENDING');
    const started = await start(worker.actor, engagementId, simulatedStartHost(true));
    expect(started).toMatchObject({
      status: 'EXECUTED',
      engagement: { id: engagementId, state: 'IN_PROGRESS', revision: before.revision + 1 },
    });
    expect(await state(engagementId)).toEqual({
      state: 'IN_PROGRESS',
      revision: before.revision + 1,
    });
    expect(await db.$queryRawUnsafe('SELECT 1 FROM "ActiveCommitment"')).toHaveLength(1);
    const events = (await db.$queryRawUnsafe(
      `SELECT "eventType" FROM "AuditEvent" WHERE "eventType"='work.engagement_started.v1'`,
    )) as unknown[];
    expect(events).toHaveLength(1);
  });
  it('replays the recorded start without a second transition, even with new writes off', async () => {
    const { worker, engagementId } = await setup();
    const key = randomUUID();
    await start(worker.actor, engagementId, ready, key);
    const replay = await start(
      worker.actor,
      engagementId,
      { ...ready, allowNewWrites: false },
      key,
    );
    expect(replay.status).toBe('REPLAYED');
    expect((await state(engagementId)).state).toBe('IN_PROGRESS');
  });
  it('answers a stranger, a missing engagement and the Founder the same way', async () => {
    const { engagementId } = await setup();
    const stranger = await seedWorkHuman(db);
    const founder = await seedWorkHuman(db, 'founder-' + randomUUID());
    for (const actor of [stranger.actor, founder.actor])
      await expect(start(actor, engagementId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(start(stranger.actor, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await state(engagementId)).state).toBe('ACCESS_PENDING');
  });
  it('refuses to start without verified binding, ready resources, enabled writes or a pending state', async () => {
    const { worker, engagementId } = await setup();
    await expect(
      start(worker.actor, engagementId, { ...ready, verifyBinding: async () => false }),
    ).rejects.toMatchObject({ code: 'FUNDING_REQUIRED' });
    await expect(
      start(worker.actor, engagementId, { ...ready, resourcesReady: async () => false }),
    ).rejects.toMatchObject({ code: 'RESOURCES_NOT_READY' });
    await expect(
      start(worker.actor, engagementId, { ...ready, allowNewWrites: false }),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    await expect(
      start(worker.actor, engagementId, simulatedStartHost(false)),
    ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect((await state(engagementId)).state).toBe('ACCESS_PENDING');
    await start(worker.actor, engagementId);
    await expect(start(worker.actor, engagementId)).rejects.toMatchObject({
      code: 'ENGAGEMENT_STATE',
    });
  });
  it('lets only one of two simultaneous starts win and rejects an unusable session', async () => {
    const { worker, engagementId } = await setup();
    const results = await Promise.allSettled([
      start(worker.actor, engagementId),
      start(worker.actor, engagementId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'ENGAGEMENT_STATE' },
    });
    expect((await state(engagementId)).revision).toBe(2);
    await db.session.deleteMany({ where: { tokenHash: worker.actor.sessionHash } });
    await expect(start(worker.actor, engagementId)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
  it('refuses to start once there is no time left to submit', async () => {
    const { worker, engagementId } = await setup({
      deadlines: {
        commitment: ahead(1500),
        preparation: ahead(1800),
        submission: ahead(2200),
        review: ahead(2500),
        operationalClosure: ahead(day),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await expect(start(worker.actor, engagementId)).rejects.toMatchObject({
      code: 'DEADLINE_PASSED',
    });
    expect((await state(engagementId)).state).toBe('ACCESS_PENDING');
  });
});
