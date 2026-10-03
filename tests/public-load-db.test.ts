import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { getRaid, getRaids, resetRaidListMemo, returningVisitors } from '../src/lib/data';
import { POST as postEvent } from '../src/app/api/events/route';
import { metrics } from '../src/lib/domain';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { routeRequest } from './helpers/route';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const visitor = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
suite('public analytics and discovery load', () => {
  let creatorId: string;
  const event = (v: number | null, type = 'raid_view') =>
    postEvent(
      routeRequest('http://localhost:3000/api/events', {
        origin: 'http://localhost:3000',
        body: { type, ...(v === null ? {} : { visitor: visitor(v) }) },
      }),
    );
  const raid = (tag: string, data: Record<string, unknown> = {}) =>
    db.raid.create({
      data: {
        creatorId,
        tag,
        title: tag,
        description: 'D',
        status: 'ACTIVE',
        startsAt: new Date(Date.now() - 3600000),
        endsAt: new Date(Date.now() + 3600000),
        ...data,
      },
    });
  const post = (raidId: string, i: number, data: Record<string, unknown> = {}) => ({
    id: `${raidId}-${i}`,
    raidId,
    authorId: `author-${i}`,
    text: `Distinct message number ${i}`,
    normalized: `distinct message number ${i}`,
    createdAt: new Date(Date.now() - 60000 - i * 1000),
    observedAt: new Date(),
    likes: 5,
    ...data,
  });
  beforeAll(async () => {
    assertTestDatabase();
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
    vi.stubEnv('TRUSTED_IP_HEADER', '');
    await truncateAll(db);
    creatorId = (await db.user.create({ data: { xId: 'load-owner', handle: 'load' } })).id;
  });
  afterEach(() => {
    vi.useRealTimers();
    resetRaidListMemo();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  it('keeps recording events from many visitors behind the shared default bucket', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T10:00:05Z'));
    for (let i = 0; i < 100; i++) expect((await event(i % 5)).status).toBe(200);
    expect(await db.event.count()).toBe(100);
  }, 60000);
  it('limits a single visitor to 60 events a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T10:05:05Z'));
    for (let i = 0; i < 60; i++) expect((await event(99)).status).toBe(200);
    expect((await event(99)).status).toBe(429);
    expect((await event(98)).status).toBe(200);
  }, 60000);
  it('does not charge the per-client limit for an invalid body', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T10:10:05Z'));
    vi.stubEnv('TRUSTED_IP_HEADER', 'x-real-ip');
    try {
      const send = (type: string) =>
        postEvent(
          routeRequest('http://localhost:3000/api/events', {
            origin: 'http://localhost:3000',
            headers: { 'x-real-ip': '203.0.113.7' },
            body: { type, visitor: visitor(97) },
          }),
        );
      for (let i = 0; i < 65; i++) expect((await send('bogus')).status).toBe(400);
      expect((await send('raid_view')).status).toBe(200);
    } finally {
      vi.stubEnv('TRUSTED_IP_HEADER', '');
    }
  });
  it('counts returning visitors by distinct days, not by number of views', async () => {
    const day = (d: number, h = 12) => new Date(Date.UTC(2026, 8, d, h));
    const rows = (v: string, ats: Date[]) =>
      ats.map((at) => ({ type: 'discovery_view', visitor: v, at }));
    await db.event.createMany({
      data: [
        ...rows('aaaaaaaa-0000-4000-8000-000000000001', [day(1, 9), day(1, 10), day(1, 11)]),
        ...rows('bbbbbbbb-0000-4000-8000-000000000002', [day(1), day(2)]),
        { type: 'raid_view', visitor: 'cccccccc-0000-4000-8000-000000000003', at: day(1) },
        { type: 'raid_view', visitor: 'cccccccc-0000-4000-8000-000000000003', at: day(2) },
      ],
    });
    expect(await returningVisitors(new Date(Date.UTC(2026, 8, 1)))).toBe(1);
    expect(await returningVisitors(new Date(Date.UTC(2026, 8, 2)))).toBe(0);
  });
  it('lists raids from the latest snapshot with a bounded activity feed, but computes detail live', async () => {
    const v1 = await raid('raid_list_v1');
    await db.post.createMany({ data: Array.from({ length: 30 }, (_, i) => post(v1.id, i)) });
    await db.snapshot.create({
      data: {
        raidId: v1.id,
        at: new Date(),
        score: 1234,
        raiders: 9,
        posts: 30,
        interactions: 99,
        complete: true,
      },
    });
    const v2 = await raid('raid_list_v2', { trackingVersion: 2 });
    await db.post.createMany({
      data: [
        ...Array.from({ length: 25 }, (_, i) => post(v2.id, i, { qualification: 'QUALIFIED' })),
        post(v2.id, 100, {
          qualification: 'QUALIFIED',
          reviewStatus: 'FLAGGED',
          createdAt: new Date(Date.now() - 1000),
        }),
      ],
    });
    const list = await getRaids();
    const first = list.find((r) => r.id === v1.id)!;
    expect(first).toMatchObject({ score: 1234, raiders: 9, posts: 30, interactions: 99 });
    expect(first.activity).toHaveLength(20);
    const second = list.find((r) => r.id === v2.id)!;
    expect(second).toMatchObject({ score: 0, posts: 0 });
    expect(second.activity).toHaveLength(20);
    expect(second.activity.some((a) => a.id === `${v2.id}-100`)).toBe(false);
    const detail = (await getRaid(v1.id))!;
    const live = metrics(await db.post.findMany({ where: { raidId: v1.id } }), new Date());
    expect(detail.score).toBe(live.score);
    expect(detail.score).not.toBe(1234);
    expect(detail.posts).toBe(30);
  });
  it('shares one query between list calls within ten seconds', async () => {
    const spy = vi.spyOn(db.raid, 'findMany');
    try {
      await Promise.all([getRaids(), getRaids()]);
      await getRaids();
      expect(spy).toHaveBeenCalledTimes(1);
      resetRaidListMemo();
      await getRaids();
      expect(spy).toHaveBeenCalledTimes(2);
      await getRaids({ tag: 'raid_list_v1' });
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});
