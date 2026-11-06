import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { db } from '../src/lib/db';
import { step } from '../src/lib/worker-jobs';
import {
  workerHealthSnapshot,
  resetRecordingBreaker,
  KNOWN_WORKER_STEPS,
  STEP_RETIRE_MS,
  PROVIDER_STALE_SECONDS,
  TX_UNKNOWN_SECONDS,
} from '../src/lib/worker-health';
import { runCommandTransaction } from '../src/lib/command-receipts-adapter';
import { commitEngagement } from '../src/work-loop/engagement-storage';
import { raidTerms } from './helpers/raid-terms-fixture';
import { seedWorkHuman, seedWorkSlot, syntheticAcceptanceHost } from './helpers/work-loop-db';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const SECONDS = 1000;
const ago = (seconds: number) => new Date(Date.now() - seconds * SECONDS);

suite('worker monitoring signals (T038 W02), synthetic data only', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    await db.$executeRawUnsafe('DELETE FROM "WorkerStepHealth"');
    resetRecordingBreaker();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => db.$disconnect());

  describe('step retirement never hides a money-path step', () => {
    const MONEY_PATH = ['measure', 'finalize', 'allocate-retry'];
    const seedAncient = async (names: string[], now: Date) => {
      const ancient = new Date(+now - STEP_RETIRE_MS - 60000);
      for (const name of names)
        await db.workerStepHealth.create({
          data: { step: name, lastRunAt: ancient, lastSuccessAt: ancient },
        });
    };
    it('keeps measure, finalize and allocate-retry stale and visible while tracking is on (or unknown)', async () => {
      const now = new Date();
      await seedAncient(MONEY_PATH, now);
      await step('alpha', async () => {});
      for (const options of [{}, { trackingEnabled: true }]) {
        const snapshot = await workerHealthSnapshot(now, options);
        expect(snapshot.status).toBe('degraded');
        expect(snapshot.reasons).toEqual(
          expect.arrayContaining(MONEY_PATH.map((name) => `step-stale:${name}`)),
        );
        expect(snapshot.retiredSteps).toEqual([]);
      }
    });
    it('retires them only when tracking is explicitly disabled, and says so by name', async () => {
      const now = new Date();
      await seedAncient([...MONEY_PATH, 'renamed-away'], now);
      await step('alpha', async () => {});
      const snapshot = await workerHealthSnapshot(now, { trackingEnabled: false });
      expect(snapshot.status).toBe('ok');
      expect(snapshot.steps.map((s) => s.step)).toEqual(['alpha']);
      expect(snapshot.retiredSteps).toEqual(
        expect.arrayContaining([
          { step: 'measure', reason: 'tracking-disabled' },
          { step: 'finalize', reason: 'tracking-disabled' },
          { step: 'allocate-retry', reason: 'tracking-disabled' },
          { step: 'renamed-away', reason: 'unknown-step' },
        ]),
      );
    });
    it('keeps the known step list identical to the steps schedule() actually runs', () => {
      const source = readFileSync(path.join(process.cwd(), 'src/lib/worker-jobs.ts'), 'utf8');
      const scheduled = [...source.matchAll(/\bawait step\('([a-z-]+)'/g)].map((m) => m[1]).sort();
      expect(scheduled.length).toBeGreaterThan(10);
      expect([...KNOWN_WORKER_STEPS].sort()).toEqual(scheduled);
      // A step spelled any other way (variable name, double quotes, a wrapper) would dodge the match above and retire.
      const calls = [...source.matchAll(/(?<!function )\bstep\(/g)];
      expect(calls).toHaveLength(scheduled.length);
    });
  });

  describe('unknown transactions (signed or submitted, outcome not yet known)', () => {
    const tx = (over: Record<string, unknown> = {}) =>
      db.financialTx.create({
        data: {
          key: 'k-' + randomUUID(),
          launchId: 'synthetic-launch',
          kind: 'PAYOUT',
          raw: 'synthetic',
          signature: 'sig-' + randomUUID(),
          blockhash: 'synthetic',
          lastValidBlockHeight: 1,
          ...over,
        },
      });
    it('reports pending counts and age without flagging a fresh transaction', async () => {
      await step('alpha', async () => {});
      await tx({ createdAt: ago(60) });
      await tx({ status: 'CONFIRMED', createdAt: ago(10 * TX_UNKNOWN_SECONDS) });
      const snapshot = await workerHealthSnapshot();
      expect(snapshot.transactions.pending).toBe(1);
      expect(snapshot.transactions.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(59);
      expect(snapshot.reasons).not.toContain('tx-unknown-overdue');
    });
    it('flags a signed transaction whose outcome is still unknown after the bound', async () => {
      await step('alpha', async () => {});
      await tx({ createdAt: ago(TX_UNKNOWN_SECONDS + 60) });
      const snapshot = await workerHealthSnapshot();
      expect(snapshot.status).toBe('degraded');
      expect(snapshot.reasons).toContain('tx-unknown-overdue');
      expect(snapshot.transactions.oldestPendingAgeSeconds).toBeGreaterThan(TX_UNKNOWN_SECONDS);
    });
    it('also counts a launch submitted but never finalized, and never exposes signatures', async () => {
      await step('alpha', async () => {});
      const user = await db.user.create({ data: { xId: 'm-owner', handle: 'm', approved: true } });
      const launch = await db.tokenLaunch.create({
        data: {
          userId: user.id,
          mint: 'MintSynthetic1111111111111111111111111111111',
          name: 'Synthetic',
          symbol: 'SYN',
          description: 'fixture',
          metadataUri: 'https://example.invalid/m',
          imageUri: 'https://example.invalid/i',
          feeAddress: 'FeeSynthetic1111111111111111111111111111111',
          feeSecret: 'synthetic',
          mintSecret: 'synthetic',
          signature: 'sig-launch-secret-looking',
          status: 'SUBMITTED',
        },
      });
      await db.$executeRaw`UPDATE "TokenLaunch" SET "updatedAt"=(NOW() AT TIME ZONE 'UTC')-make_interval(secs => ${TX_UNKNOWN_SECONDS + 60}) WHERE id=${launch.id}`;
      const snapshot = await workerHealthSnapshot();
      expect(snapshot.transactions.pending).toBe(1);
      expect(snapshot.reasons).toContain('tx-unknown-overdue');
      expect(JSON.stringify(snapshot)).not.toContain('sig-launch');
    });
  });

  describe('provider freshness', () => {
    const MINT = 'So11111111111111111111111111111111111111112';
    async function activeRaid(
      over: { observedAt?: Date | null; marketAt?: Date | null; startsAt?: Date } = {},
    ) {
      const user = await db.user.create({ data: { xId: 'p-owner', handle: 'p', approved: true } });
      await db.token.create({
        data: { mint: MINT, symbol: 'SOL', name: 'Solana', marketAt: over.marketAt ?? null },
      });
      return db.raid.create({
        data: {
          tag: 'p-' + randomUUID().slice(0, 8),
          title: 'Fresh',
          description: 'Synthetic fixture.',
          creatorId: user.id,
          mint: MINT,
          status: 'ACTIVE',
          startsAt: over.startsAt ?? ago(3 * 3600),
          endsAt: new Date(Date.now() + 3600 * SECONDS),
          observedAt: over.observedAt ?? null,
        },
      });
    }
    const collection = (on: boolean) =>
      db.settings.upsert({
        where: { id: 'global' },
        create: { collectionEnabled: on },
        update: { collectionEnabled: on },
      });
    it('flags stale X observation and stale market data for an active raid', async () => {
      await step('alpha', async () => {});
      await collection(true);
      await activeRaid({
        observedAt: ago(PROVIDER_STALE_SECONDS + 120),
        marketAt: ago(PROVIDER_STALE_SECONDS + 120),
      });
      const snapshot = await workerHealthSnapshot();
      expect(snapshot.providers.collection).toMatchObject({ enabled: true, staleRaids: 1 });
      expect(snapshot.providers.market).toMatchObject({ staleTokens: 1 });
      expect(snapshot.reasons).toEqual(
        expect.arrayContaining(['provider-stale:x', 'provider-stale:market']),
      );
    });
    it('is quiet when data is fresh, and does not judge X freshness while collection is off', async () => {
      await step('alpha', async () => {});
      await collection(false);
      await activeRaid({ observedAt: ago(5 * 3600), marketAt: ago(60) });
      const snapshot = await workerHealthSnapshot();
      expect(snapshot.providers.collection.enabled).toBe(false);
      expect(snapshot.providers.collection.staleRaids).toBeNull();
      expect(snapshot.providers.market.staleTokens).toBe(0);
      expect(snapshot.reasons.filter((r) => r.startsWith('provider-stale'))).toEqual([]);
    });
    it('never leaks market payloads, raid ids or errors', async () => {
      await step('alpha', async () => {});
      await collection(true);
      const raid = await activeRaid({ observedAt: ago(PROVIDER_STALE_SECONDS + 120) });
      await db.raid.update({ where: { id: raid.id }, data: { collectionError: 'secret-body' } });
      const text = JSON.stringify(await workerHealthSnapshot());
      expect(text).not.toContain(raid.id);
      expect(text).not.toContain('secret-body');
    });
  });

  describe('commitment deadlines', () => {
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    async function committed() {
      const worker = await seedWorkHuman(db);
      const reviewer = await seedWorkHuman(db, 'reviewer-' + randomUUID());
      const closure = at(3500);
      const slot = await seedWorkSlot(db, undefined, {
        review: { ...raidTerms().review, reviewerAccountId: reviewer.actor.accountId },
        deadlines: {
          commitment: at(3000),
          preparation: at(3100),
          submission: at(3200),
          review: at(3300),
          operationalClosure: closure,
        },
      });
      await runCommandTransaction(db, (tx) =>
        commitEngagement(
          tx,
          {
            actor: worker.actor,
            input: { slotId: slot.slotId, termsVersionId: slot.termsVersionId },
            idempotencyKey: randomUUID(),
            requestId: 'monitor-commit',
          },
          syntheticAcceptanceHost,
        ),
      );
      return closure;
    }
    it('counts an active engagement past its accepted operational deadline, and flags it only when closure is on', async () => {
      await step('alpha', async () => {});
      const closure = await committed();
      const early = await workerHealthSnapshot(new Date(), { closureEnabled: true });
      expect(early.commitments.pastDeadline).toBe(0);
      await db.$queryRawUnsafe(
        `SELECT pg_sleep(GREATEST(0, extract(epoch FROM $1::timestamptz-clock_timestamp()))+0.1)::text`,
        closure,
      );
      const late = await workerHealthSnapshot(new Date(), {
        closureEnabled: true,
        commitmentOverdueSeconds: 0,
      });
      expect(late.commitments.pastDeadline).toBe(1);
      expect(late.commitments.oldestPastDeadlineSeconds).toBeGreaterThanOrEqual(0);
      expect(late.reasons).toContain('commitment-deadline-overdue');
      const off = await workerHealthSnapshot(new Date(), {
        closureEnabled: false,
        commitmentOverdueSeconds: 0,
      });
      expect(off.commitments.pastDeadline).toBe(1);
      expect(off.reasons).not.toContain('commitment-deadline-overdue');
      expect(JSON.stringify(late)).not.toMatch(/engagementId|participantId|synthetic:/);
    }, 30000);
  });
});
