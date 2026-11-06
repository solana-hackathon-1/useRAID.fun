import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T091 (#161) W02/C14: a body is size-bounded BEFORE it is buffered or parsed. A public or low-privilege caller must not
 * make the web process hold an arbitrarily large request in memory, whatever the later schema or file-size check says.
 */
const mocks = vi.hoisted(() => ({
  eventCreate: vi.fn(),
  challenge: vi.fn(),
  store: vi.fn(),
  verify: vi.fn(),
  rotate: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: vi.fn(),
  publicRateLimit: vi.fn(),
  rateLimit: vi.fn(),
  currentUser: async () => null,
  requireUser: async () => ({ id: 'user-1' }),
}));
vi.mock('../src/lib/db', () => ({ db: { event: { create: mocks.eventCreate } } }));
vi.mock('../src/lib/wallet-auth', () => ({
  createWalletChallenge: mocks.challenge,
  verifyWalletChallenge: mocks.verify,
  rotateWallet: mocks.rotate,
}));
vi.mock('../src/lib/media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/media')>()),
  storeImage: mocks.store,
}));
import { POST as challenge } from '../src/app/api/wallet/challenge/route';
import { POST as verify } from '../src/app/api/wallet/verify/route';
import { POST as events } from '../src/app/api/events/route';
import { POST as studioImage } from '../src/app/api/studio/image/route';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type: string, data: number[]) {
  const body = [...type].map((c) => c.charCodeAt(0)).concat(data);
  let c = 0xffffffff;
  for (const b of body) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return [...u32(data.length), ...body, ...u32((c ^ 0xffffffff) >>> 0)];
}
const tinyPng = () =>
  new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk('IHDR', [...u32(1), ...u32(1), 8, 2, 0, 0, 0]),
    ...chunk('IDAT', [0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1]),
    ...chunk('IEND', []),
  ]);

const CHUNK = 64 * 1024;
const HUGE = 64 * 1024 * 1024;
/**
 * A request whose body is `total` bytes that the handler pulls on demand; `pulled()` reports what it actually read.
 * The stream has no read-ahead buffer (highWaterMark 0), so `pulled()` is exactly the bytes the handler asked for.
 * `declare` is the Content-Length header to send: the true length, a lie, or none (chunked).
 */
function streamed(contentType: string, total: number, declare: number | boolean) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= total) return controller.close();
        const size = Math.min(CHUNK, total - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(32));
      },
    },
    new CountQueuingStrategy({ highWaterMark: 0 }),
  );
  const headers: Record<string, string> = { 'content-type': contentType };
  if (declare === true) headers['content-length'] = String(total);
  else if (typeof declare === 'number') headers['content-length'] = String(declare);
  const request = new Request('http://localhost/api/x', {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit);
  return { request, pulled: () => sent };
}
const routes = [
  ['wallet challenge', challenge, 'application/json'],
  ['wallet verify', verify, 'application/json'],
  ['events', events, 'application/json'],
  ['studio image', studioImage, 'multipart/form-data; boundary=x'],
] as const;

beforeEach(() => {
  mocks.eventCreate.mockReset();
  mocks.challenge.mockReset().mockResolvedValue({ digest: 'd', message: 'm' });
  mocks.store.mockReset();
  mocks.verify.mockReset();
  mocks.rotate.mockReset();
});
describe('request bodies are bounded before they are buffered', () => {
  describe.each(routes)('%s', (_name, handler, contentType) => {
    it('rejects a declared oversize body with 413 without reading it', async () => {
      const { request, pulled } = streamed(contentType, HUGE, true);
      expect((await handler(request)).status).toBe(413);
      // Refused from the header alone: not one byte may be read. Only the Content-Length pre-check can do this.
      expect(pulled()).toBe(0);
    });
    it('stops reading a body whose small Content-Length lies about its real size', async () => {
      const { request, pulled } = streamed(contentType, HUGE, 10);
      expect((await handler(request)).status).toBe(413);
      expect(pulled()).toBeLessThan(1024 * 1024);
    });
    it('stops reading an undeclared (chunked) oversize body and answers 413', async () => {
      const { request, pulled } = streamed(contentType, HUGE, false);
      expect((await handler(request)).status).toBe(413);
      expect(pulled()).toBeLessThan(1024 * 1024);
    });
  });
  describe.each([
    ['wallet challenge', challenge],
    ['wallet verify', verify],
    ['events', events],
  ])('%s JSON shape', (_name, handler) => {
    it.each([
      ['an array', '[]'],
      ['null', 'null'],
      ['a string', '"x"'],
      ['malformed JSON', '{'],
    ])('rejects %s with 400', async (_label, body) => {
      const response = await handler(
        new Request('http://localhost/api/x', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(mocks.challenge).not.toHaveBeenCalled();
      expect(mocks.eventCreate).not.toHaveBeenCalled();
    });
  });
  it.each([
    ['declared', true],
    ['lying small length', 10],
    ['chunked', false],
  ] as const)(
    'wallet verify never reaches signature verification or rotation after a 413 (%s)',
    async (_label, declare) => {
      const { request } = streamed('application/json', HUGE, declare);
      expect((await verify(request)).status).toBe(413);
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(mocks.rotate).not.toHaveBeenCalled();
    },
  );
  it('still stores an ordinary small image upload', async () => {
    mocks.store.mockResolvedValue('/api/media/abc');
    const form = new FormData();
    form.set('file', new File([tinyPng() as BlobPart], 'logo.png', { type: 'image/png' }));
    const response = await studioImage(
      new Request('http://localhost/api/studio/image', { method: 'POST', body: form }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ imageUri: '/api/media/abc' });
    expect(mocks.store).toHaveBeenCalledOnce();
  });
  it('rejects a non-multipart body to the image route with 400', async () => {
    const response = await studioImage(
      new Request('http://localhost/api/studio/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(400);
  });
  it('still accepts ordinary small bodies', async () => {
    const ok = await challenge(
      new Request('http://localhost/api/wallet/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'abc' }),
      }),
    );
    expect(ok.status).toBe(200);
    mocks.eventCreate.mockResolvedValue({});
    const event = await events(
      new Request('http://localhost/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'raid_view', raidId: 'r1' }),
      }),
    );
    expect(event.status).toBe(200);
  });
});
