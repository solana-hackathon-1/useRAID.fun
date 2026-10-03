import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { db } from '../src/lib/db';
import { createRaid, changeRaid } from '../src/lib/campaigns';
import { collect, ingest, refresh, snapshot } from '../src/lib/collection';
import { claimJob, enqueue, finishJob, JOB_MAX_ATTEMPTS } from '../src/lib/queue';
import { reserveUsage, lookupPosts } from '../src/lib/providers/x';
import { config } from '../src/lib/config';
import { metrics } from '../src/lib/domain';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('PostgreSQL integration', () => {
  let user: Awaited<ReturnType<typeof db.user.create>>, raidId: string;
  const input = {
    title: 'Integration campaign',
    description: 'A real database integration fixture.',
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL',
    name: 'Solana',
  };
  beforeAll(async () => {
    vi.stubEnv('X_TRACKING_V2_ENABLED', 'false');
    assertTestDatabase();
    await truncateAll(db);
    user = await db.user.create({ data: { xId: 'test-owner', handle: 'test', approved: true } });
    await db.xAccount.create({
      data: { userId: user.id, xUserId: 'test-owner', username: 'test', displayName: 'Test' },
    });
    const raid = await createRaid(user, input);
    raidId = raid.id;
    config.demo = false;
    config.liveApproved = true;
    process.env.X_BEARER_TOKEN = 'test-only';
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  it('rejects unapproved creation and cross-owner mutation', async () => {
    await expect(createRaid({ ...user, approved: false }, input)).rejects.toMatchObject({
      status: 403,
    });
    await expect(changeRaid({ ...user, id: 'another' }, raidId, 'launch')).rejects.toMatchObject({
      status: 403,
    });
  });
  it('enforces the pilot slot quota under concurrent launch requests', async () => {
    await db.settings.upsert({
      where: { id: 'global' },
      create: { maxActiveRaids: 1 },
      update: { maxActiveRaids: 1 },
    });
    const second = await createRaid(user, { ...input, title: 'Second campaign' });
    const results = await Promise.allSettled([
      changeRaid(user, raidId, 'launch'),
      changeRaid(user, second.id, 'launch'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const active = await db.raid.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    raidId = active.id;
  });
  it('does not inflate counters when overlapping jobs ingest the same post', async () => {
    const raid = await db.raid.update({
      where: { id: raidId },
      data: { startsAt: new Date(Date.now() - 3600000) },
    });
    const p = {
      id: '12345',
      author_id: 'alice',
      text: `Hello from our community @useRAID #${raid.tag}`,
      created_at: new Date(Date.now() - 1000).toISOString(),
      entities: { mentions: [{ username: 'useRAID' }], hashtags: [{ tag: raid.tag }] },
      public_metrics: { like_count: 5, reply_count: 1, retweet_count: 2, quote_count: 1 },
    };
    await ingest(raidId, [p]);
    await ingest(raidId, [p]);
    expect(await db.post.count({ where: { raidId } })).toBe(1);
    await ingest(raidId, [{ ...p, public_metrics: { ...p.public_metrics, like_count: 2 } }]);
    const posts = await db.post.findMany({ where: { raidId } });
    expect(metrics(posts, new Date()).interactions).toBe(6);
    await db.post.update({ where: { id: p.id }, data: { hidden: true } });
    await ingest(raidId, [p]);
    expect(metrics(await db.post.findMany({ where: { raidId } }), new Date()).score).toBe(0);
  });
  it('deduplicates queued jobs, claims once, and rejects stale lease completion', async () => {
    await enqueue('test', 'same', { raidId });
    await enqueue('test', 'same', { raidId });
    expect(await db.job.count()).toBe(1);
    const claims = await Promise.all([claimJob(), claimJob()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const job = claims.find(Boolean)!;
    await finishJob({ ...job, lease: 'invalid' });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).doneAt).toBeNull();
    await finishJob(job);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).doneAt).not.toBeNull();
  });
  it('enforces kill switch and reserves budget atomically', async () => {
    await expect(reserveUsage(100, raidId)).rejects.toThrow('paused');
    await db.settings.update({
      where: { id: 'global' },
      data: { collectionEnabled: true, cutoffCents: 50 },
    });
    const results = await Promise.allSettled([
      reserveUsage(100, raidId),
      reserveUsage(100, raidId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('backs off on rate limits and preserves data on missing transport results', async () => {
    await db.settings.update({ where: { id: 'global' }, data: { cutoffCents: 18000 } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{}', {
          status: 429,
          headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 300) },
        }),
      ),
    );
    await expect(lookupPosts(['12345'], raidId)).rejects.toMatchObject({
      retryAfter: expect.any(Number),
    });
    await expect(refresh(raidId, '', false)).rejects.toThrow('rate-limit reset');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await db.post.findUniqueOrThrow({ where: { id: '12345' } })).deleted).toBe(false);
  });
  it('removes content for an explicit provider deletion', async () => {
    await db.xEndpointState.updateMany({
      data: { blockedUntil: new Date(0), resetAt: new Date(0) },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              { resource_id: '12345', type: 'https://api.x.com/2/problems/resource-not-found' },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await refresh(raidId, '', false);
    const post = await db.post.findUniqueOrThrow({ where: { id: '12345' } });
    expect(post.deleted).toBe(true);
    expect(post.text).toBe('');
  });
  it('serializes different jobs for the same raid', async () => {
    await enqueue('test', 'raid-lock-a', { raidId });
    await enqueue('test', 'raid-lock-b', { raidId });
    const [a, b] = await Promise.all([claimJob(), claimJob()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    await finishJob((a || b)!);
    const next = await claimJob();
    expect(next).not.toBeNull();
    await finishJob(next!);
  });
  it('keeps the first-page high water mark while resuming pagination', async () => {
    await db.raid.update({
      where: { id: raidId },
      data: { finalRefreshed: false, nextToken: null, sinceId: null, searchEndAt: null },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: [], meta: { newest_id: '999', next_token: 'page-2' } }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [], meta: { newest_id: '888' } })),
        ),
    );
    await collect(raidId);
    const partial = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    expect(partial.nextToken).toBe('page-2');
    expect(partial.sinceId).toBeNull();
    await collect(raidId);
    const complete = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    expect(complete.sinceId).toBe('999');
    expect(complete.nextToken).toBeNull();
  });
  it('does not treat an edited nonqualifying post as current participation', async () => {
    const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
    const p = {
      id: 'changed-post',
      author_id: 'bob',
      text: 'Original qualifying text',
      created_at: new Date().toISOString(),
      entities: { mentions: [{ username: 'useRAID' }], hashtags: [{ tag: raid.tag }] },
      public_metrics: { like_count: 1, reply_count: 0, quote_count: 0, retweet_count: 0 },
    };
    await ingest(raidId, [p]);
    await expect(ingest(raidId, [{ ...p, public_metrics: undefined }])).rejects.toThrow('metrics');
    expect((await db.post.findUniqueOrThrow({ where: { id: p.id } })).likes).toBe(1);
    await ingest(raidId, [{ ...p, entities: { mentions: [], hashtags: [] } }]);
    expect((await db.post.findUniqueOrThrow({ where: { id: p.id } })).deleted).toBe(true);
  });
  it('claims jobs by UTC regardless of session time zone', async () => {
    await db.job.deleteMany();
    await db.$executeRawUnsafe(`ALTER ROLE CURRENT_USER SET TimeZone='Pacific/Kiritimati'`);
    await db.$disconnect();
    await db.$connect();
    try {
      await enqueue('test', 'tz-future', { raidId: 'tz-a' }, new Date(Date.now() + 3600000));
      const due = await enqueue('test', 'tz-due', { raidId: 'tz-b' }, new Date(Date.now() - 1000));
      const claimed = await claimJob();
      expect(claimed?.id).toBe(due.id);
      expect(await claimJob()).toBeNull();
      expect(Math.abs(+claimed!.lockedAt! - Date.now())).toBeLessThan(5000);
    } finally {
      await db.$executeRawUnsafe(`ALTER ROLE CURRENT_USER RESET TimeZone`);
      await db.$disconnect();
      await db.$connect();
      await db.job.deleteMany();
    }
  });
  it('dead-letters a job after the maximum attempts', async () => {
    await db.job.deleteMany();
    const queued = await enqueue('test', 'dead-1', { raidId: 'dead-a' });
    for (let attempt = 1; attempt <= JOB_MAX_ATTEMPTS; attempt++) {
      await db.job.update({
        where: { id: queued.id },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      const job = (await claimJob())!;
      expect(job.attempts).toBe(attempt);
      const result = await finishJob(job, 'boom');
      expect(result.dead).toBe(attempt === JOB_MAX_ATTEMPTS);
    }
    const row = await db.job.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row.failedAt).not.toBeNull();
    expect(row.doneAt).toBeNull();
    await db.job.update({ where: { id: queued.id }, data: { runAt: new Date(Date.now() - 1000) } });
    expect(await claimJob()).toBeNull();
    await db.job.deleteMany();
  });
  it('does not consume attempts for deferred provider errors', async () => {
    await db.job.deleteMany();
    const queued = await enqueue('test', 'deferred-1', { raidId: 'deferred-a' });
    for (let i = 0; i < JOB_MAX_ATTEMPTS + 2; i++) {
      await db.job.update({
        where: { id: queued.id },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      const job = (await claimJob())!;
      expect(job.attempts).toBe(1);
      expect(await finishJob(job, 'paused', 300, { refundAttempt: true })).toEqual({ dead: false });
    }
    const row = await db.job.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row.attempts).toBe(0);
    expect(row.failedAt).toBeNull();
    await db.job.deleteMany();
  });
  it('never dead-letters through a stale lease', async () => {
    await db.job.deleteMany();
    await enqueue('test', 'stale-1', { raidId: 'stale-a' });
    const job = (await claimJob())!;
    await db.job.update({ where: { id: job.id }, data: { attempts: JOB_MAX_ATTEMPTS } });
    expect(await finishJob({ ...job, attempts: JOB_MAX_ATTEMPTS, lease: 'x' }, 'e')).toEqual({
      dead: false,
    });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).failedAt).toBeNull();
    await db.job.deleteMany();
  });
  it('treats transport failures and 5xx as deferred provider errors', async () => {
    vi.stubEnv('X_BEARER_TOKEN', 'test-only');
    await db.xEndpointState.deleteMany();
    await db.settings.upsert({
      where: { id: 'global' },
      create: { collectionEnabled: true },
      update: { collectionEnabled: true },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(lookupPosts(['1'], raidId)).rejects.toMatchObject({ deferred: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    await expect(lookupPosts(['1'], raidId)).rejects.toMatchObject({
      deferred: true,
      status: 503,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 400 })),
    );
    await expect(lookupPosts(['1'], raidId)).rejects.toMatchObject({
      deferred: false,
      status: 400,
    });
    vi.unstubAllGlobals();
    await db.xEndpointState.deleteMany();
  });
  describe('lookup and finalization correctness', () => {
    const base = 'https://api.x.com/2/problems/';
    const livePost = (id: string, tag: string) => ({
      id,
      author_id: 'carol',
      text: `Post ${id} @useRAID #${tag}`,
      created_at: new Date(Date.now() - 1000).toISOString(),
      entities: { mentions: [{ username: 'useRAID' }], hashtags: [{ tag }] },
      public_metrics: { like_count: 1, reply_count: 0, quote_count: 0, retweet_count: 0 },
    });
    async function reset(patch: Record<string, unknown> = {}) {
      await db.settings.upsert({
        where: { id: 'global' },
        create: { collectionEnabled: true, cutoffCents: 18000, dailyRequestLimit: 100000 },
        update: { collectionEnabled: true, cutoffCents: 18000, dailyRequestLimit: 100000 },
      });
      await db.providerUsage.deleteMany();
      await db.xEndpointState.deleteMany();
      await db.snapshot.deleteMany({ where: { raidId } });
      await db.post.deleteMany({ where: { raidId } });
      return db.raid.update({
        where: { id: raidId },
        data: {
          status: 'ACTIVE',
          startsAt: new Date(Date.now() - 3600000),
          endsAt: new Date(Date.now() + 3600000),
          finalRefreshed: false,
          coveredUntil: null,
          coverage: 'partial',
          nextToken: null,
          sinceId: null,
          searchEndAt: null,
          pendingNewestId: null,
          ...patch,
        },
      });
    }
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    it('does not let a protected or suspended author break refresh', async () => {
      const raid = await reset();
      await ingest(raidId, [livePost('7001', raid.tag), livePost('7002', raid.tag)]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          json({
            data: [livePost('7001', raid.tag)],
            errors: [{ resource_id: '7002', type: `${base}not-authorized-for-resource` }],
          }),
        ),
      );
      await refresh(raidId, '', false);
      expect(await db.post.findUniqueOrThrow({ where: { id: '7002' } })).toMatchObject({
        deleted: true,
        text: '',
      });
      expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).coverage).toBe(
        'complete',
      );
    });
    it('still throws for unknown lookup errors on a v1 non-final pass and escalates on the final pass', async () => {
      const raid = await reset();
      await ingest(raidId, [livePost('7003', raid.tag)]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json({ data: [] })),
      );
      await expect(refresh(raidId, '', true, undefined, undefined, 4)).rejects.toThrow(
        'incomplete lookup',
      );
      expect((await db.post.findUniqueOrThrow({ where: { id: '7003' } })).deleted).toBe(false);
      await refresh(raidId, '', true, undefined, undefined, 5);
      expect((await db.post.findUniqueOrThrow({ where: { id: '7003' } })).deleted).toBe(true);
      expect((await db.raid.findUniqueOrThrow({ where: { id: raidId } })).finalRefreshed).toBe(
        true,
      );
    });
    it('keeps a late non-final refresh from undoing the final state', async () => {
      const endsAt = new Date(Date.now() - 60000);
      await reset({ status: 'ENDED', endsAt, finalRefreshed: true, coveredUntil: endsAt });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json({ data: [] })),
      );
      await refresh(raidId, '', false, new Date(+endsAt - 3600000).toISOString());
      const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      expect(raid.finalRefreshed).toBe(true);
      expect(+raid.coveredUntil!).toBe(+endsAt);
    });
    it('writes no coverage when the search cursor moved after the refresh began', async () => {
      const endsAt = new Date(Date.now() - 60000);
      await reset({ status: 'ENDED', endsAt, searchEndAt: endsAt });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json({ data: [] })),
      );
      await refresh(raidId, '', true, endsAt.toISOString());
      const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      expect(raid.finalRefreshed).toBe(false);
      expect(raid.coveredUntil).toBeNull();
    });
    it('does not downgrade a complete snapshot with an incomplete one in the same minute', async () => {
      await reset();
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T10:00:10Z') });
      try {
        await snapshot(raidId, true);
        await snapshot(raidId, false);
        expect(await db.snapshot.findMany({ where: { raidId } })).toMatchObject([
          { complete: true },
        ]);
        await db.snapshot.deleteMany({ where: { raidId } });
        await snapshot(raidId, false);
        await snapshot(raidId, true);
        expect(await db.snapshot.findMany({ where: { raidId } })).toMatchObject([
          { complete: true },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
    it('does not overwrite cursors changed by a concurrent end', async () => {
      await reset();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const searching = new Promise<void>((resolve) => (started = resolve));
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          started();
          await gate;
          return json({ data: [], meta: { newest_id: '5555', next_token: 'stale-page' } });
        }),
      );
      const running = collect(raidId, 'stale');
      await searching;
      await changeRaid(user, raidId, 'end');
      release();
      await running;
      const raid = await db.raid.findUniqueOrThrow({ where: { id: raidId } });
      expect(raid.nextToken).toBeNull();
      expect(raid.pendingNewestId).toBeNull();
      expect(await db.job.count({ where: { key: { startsWith: `page:${raidId}` } } })).toBe(0);
    });
  });
});
