import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { db } from '../src/lib/db';
import { createRaid } from '../src/lib/campaigns';
import { config } from '../src/lib/config';
import { getRaid, getRaids, getToken, resetRaidListMemo } from '../src/lib/data';
import { claimJob, enqueue } from '../src/lib/queue';
import { runJob } from '../src/lib/worker-jobs';
import { MarketPanel } from '../src/components/market';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const market = vi.hoisted(() => ({ failWith: null as Error | null, result: null as unknown }));
vi.mock('../src/lib/providers/market', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/providers/market')>()),
  fetchMarket: async () => {
    if (market.failWith) throw market.failWith;
    return market.result;
  },
}));

const MINT = 'So11111111111111111111111111111111111111112';
const SECRET = 'https://api.provider.example/v1/pairs?apikey=sk_live_FAKE_SECRET_0123';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

suite('public error projection', () => {
  let raidId: string;
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
  });
  beforeEach(async () => {
    await truncateAll(db);
    resetRaidListMemo();
    market.failWith = null;
    market.result = null;
    const user = await db.user.create({ data: { xId: 'pe-owner', handle: 'pe', approved: true } });
    await db.xAccount.create({
      data: { userId: user.id, xUserId: 'pe-owner', username: 'pe', displayName: 'P' },
    });
    raidId = (
      await createRaid(user, {
        title: 'Projection campaign',
        description: 'A projection fixture campaign.',
        mint: MINT,
        symbol: 'SOL',
        name: 'Solana',
      })
    ).id;
    await db.raid.update({ where: { id: raidId }, data: { status: 'ACTIVE' } });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  async function failMarketJob(error: Error) {
    market.failWith = error;
    await enqueue('market', `market:${MINT}:1`, { mint: MINT, raidId });
    const job = (await claimJob())!;
    await runJob(job);
  }

  it('keeps the raw provider error for operators but never in public raid or token output', async () => {
    await failMarketJob(new Error(`fetch failed: ${SECRET}`));
    // operators still see the raw detail
    expect((await db.token.findUniqueOrThrow({ where: { mint: MINT } })).marketError).toContain(
      SECRET,
    );
    expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).collectionError).toContain(
      SECRET,
    );

    resetRaidListMemo();
    const raid = (await getRaid(raidId))!;
    const token = (await getToken(MINT))!;
    const list = await getRaids();
    const html = renderToStaticMarkup(
      MarketPanel({ market: null, at: null, error: raid.marketError, demo: false }),
    );
    const publicOutput = JSON.stringify({ raid, token, list }) + html;
    expect(publicOutput).not.toContain('sk_live_FAKE_SECRET');
    expect(publicOutput).not.toContain('api.provider.example');
    // the error state itself is still shown
    expect(raid.marketError).toBeTruthy();
    expect(token.marketError).toBeTruthy();
    expect(html).toContain('temporarily unavailable');
  });

  it('keeps the no-market-pair message and the empty state unchanged', async () => {
    market.result = null;
    await enqueue('market', `market:${MINT}:2`, { mint: MINT, raidId });
    await runJob((await claimJob())!);
    expect((await getRaid(raidId))!.marketError).toBe('No eligible market pair found.');
    await db.token.update({ where: { mint: MINT }, data: { marketError: null } });
    resetRaidListMemo();
    expect((await getRaid(raidId))!.marketError).toBeNull();
  });
});
