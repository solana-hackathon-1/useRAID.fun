import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: () => {},
  requireUser: async () => mocks.user,
  rateLimit: async () => {},
}));
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { saveStudioRaid } from '../src/lib/studio-campaigns';
import { backfillMedia } from '../src/lib/media';
import { POST as upload } from '../src/app/api/studio/image/route';
import { GET } from '../src/app/api/media/[id]/route';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { routeContext } from './helpers/route';
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const form = (bytes: Uint8Array, name = 'logo.png') => {
  const body = new FormData();
  body.set('file', new File([bytes as BlobPart], name));
  return new Request('http://localhost:3000/api/studio/image', { method: 'POST', body });
};
suite('Studio media assets', () => {
  let owner: Awaited<ReturnType<typeof db.user.create>>;
  beforeAll(async () => {
    assertTestDatabase();
    config.demo = false;
    await truncateAll(db);
    owner = await db.user.create({ data: { xId: 'media-owner', handle: 'media', approved: true } });
    await db.xAccount.create({
      data: { userId: owner.id, xUserId: 'media-owner', username: 'media', displayName: 'Media' },
    });
    mocks.user = owner;
  });
  afterAll(() => db.$disconnect());
  it('stores identical uploads once and returns a media path', async () => {
    const first = await (await upload(form(png))).json();
    const second = await (await upload(form(png, 'again.png'))).json();
    expect(first.imageUri).toMatch(/^\/api\/media\/[a-z0-9]{20,40}$/);
    expect(second.imageUri).toBe(first.imageUri);
    expect(await db.mediaAsset.count()).toBe(1);
    expect(await db.mediaAsset.findFirstOrThrow()).toMatchObject({
      mime: 'image/png',
      size: png.length,
      uploaderId: owner.id,
    });
  });
  it('refuses content that is not an image or is too large', async () => {
    expect(
      (await upload(form(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).status,
    ).toBe(400);
    expect((await upload(form(Buffer.concat([png, Buffer.alloc(256000)])))).status).toBe(400);
    expect(await db.mediaAsset.count()).toBe(1);
  });
  it('serves the bytes with immutable caching and a pinned content type', async () => {
    const { id } = await db.mediaAsset.findFirstOrThrow();
    const response = await GET(
      new Request('http://localhost:3000/api/media/x'),
      routeContext({ id }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
  });
  it('answers 404 for unknown or malformed ids', async () => {
    for (const id of ['x'.repeat(25), '../etc', 'short'])
      expect(
        (await GET(new Request('http://localhost:3000/api/media/x'), routeContext({ id }))).status,
      ).toBe(404);
  });
  it('moves a legacy data URI from a saved draft into a media asset', async () => {
    const draft = await saveStudioRaid(owner, {
      studioVersion: 1,
      projectType: 'PROJECT',
      title: 'Legacy image draft',
      imageUri: `data:image/png;base64,${png.toString('base64')}`,
      impressionTarget: 2000,
      duration: 24,
    });
    const { id } = await db.mediaAsset.findFirstOrThrow();
    expect((await db.raid.findUniqueOrThrow({ where: { id: draft.id } })).imageUri).toBe(
      `/api/media/${id}`,
    );
    expect(await db.mediaAsset.count()).toBe(1);
    await expect(
      saveStudioRaid(owner, {
        studioVersion: 1,
        projectType: 'PROJECT',
        title: 'Spoofed image draft',
        imageUri: `data:image/jpeg;base64,${png.toString('base64')}`,
        impressionTarget: 2000,
        duration: 24,
      }),
    ).rejects.toThrow();
  });
  it('backfills inline images on raids and tokens and leaves invalid ones alone', async () => {
    const uri = `data:image/png;base64,${png.toString('base64')}`;
    const raid = await db.raid.create({
      data: {
        creatorId: owner.id,
        tag: 'raid_backfill',
        title: 'Backfill',
        description: 'D',
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 1000),
        imageUri: uri,
      },
    });
    const bad = await db.raid.create({
      data: {
        creatorId: owner.id,
        tag: 'raid_backfill_bad',
        title: 'Bad',
        description: 'D',
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 1000),
        imageUri: 'data:image/png;base64,AAAA',
      },
    });
    await db.token.create({
      data: { mint: 'BackfillMint1', name: 'T', symbol: 'T', imageUri: uri },
    });
    const result = await backfillMedia();
    expect(result).toEqual({ moved: 2, skipped: 1 });
    const { id } = await db.mediaAsset.findFirstOrThrow();
    expect((await db.raid.findUniqueOrThrow({ where: { id: raid.id } })).imageUri).toBe(
      `/api/media/${id}`,
    );
    expect((await db.token.findUniqueOrThrow({ where: { mint: 'BackfillMint1' } })).imageUri).toBe(
      `/api/media/${id}`,
    );
    expect((await db.raid.findUniqueOrThrow({ where: { id: bad.id } })).imageUri).toMatch(/^data:/);
    expect(await db.mediaAsset.count()).toBe(1);
  });
});
