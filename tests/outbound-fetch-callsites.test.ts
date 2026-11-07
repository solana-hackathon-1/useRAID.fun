import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/lib/config';
import { fetchXIdentity } from '../src/lib/x-oauth';
import { pinFile } from '../src/lib/launch-ipfs';
import { fetchMarket } from '../src/lib/providers/market';

/** T091-W03: every provider call site refuses redirects and bounds what it parses. */
const usage = vi.hoisted(() => ({ reserve: vi.fn(), settle: vi.fn() }));
vi.mock('../src/lib/providers/x', () => ({
  reserveUsage: usage.reserve,
  settleReservation: usage.settle,
}));
const huge = (bytes: number) => new Response(JSON.stringify({ pad: 'x'.repeat(bytes) }));
const redirectFailure = () =>
  Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });

beforeEach(() => {
  usage.reserve.mockReset().mockResolvedValue({ id: 'reservation' });
  usage.settle.mockReset();
  config.demo = false;
  config.appUrl = 'http://localhost:3000';
  vi.stubEnv('X_CLIENT_ID', 'fixture-client');
  vi.stubEnv('X_CLIENT_SECRET', 'fixture-secret');
  vi.stubEnv('PINATA_JWT', 'fixture-jwt');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Pinata upload', () => {
  const file = () => new File(['x'], 'a.png', { type: 'image/png' });
  it('sends the JWT only with redirects refused', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { cid: 'bafy' + 'a'.repeat(30) } }));
    vi.stubGlobal('fetch', fetcher);
    await pinFile(file());
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://uploads.pinata.cloud/v3/files');
    expect(init.headers.Authorization).toBe('Bearer fixture-jwt');
    expect(init.redirect).toBe('error');
  });
  it('maps a refused redirect to the existing upload failure without leaking the credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(redirectFailure()));
    const failure = await pinFile(file()).catch((error) => error);
    expect(failure).toMatchObject({ status: 503, message: 'IPFS upload failed.' });
    expect(JSON.stringify(failure)).not.toContain('fixture-jwt');
  });
  it('refuses an oversized provider reply', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(huge(256 * 1024)));
    await expect(pinFile(file())).rejects.toMatchObject({
      status: 503,
      message: 'IPFS upload failed.',
    });
  });
});

describe('DexScreener market', () => {
  it('refuses redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json([]));
    vi.stubGlobal('fetch', fetcher);
    await fetchMarket('So11111111111111111111111111111111111111112');
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });
  it('surfaces a refused redirect as a typed provider failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(redirectFailure()));
    await expect(fetchMarket('mint')).rejects.toMatchObject({ code: 'redirect' });
  });
  it('refuses an oversized reply', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(huge(3 * 1024 * 1024)));
    await expect(fetchMarket('mint')).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('X OAuth identity', () => {
  const token = () => Response.json({ access_token: 'fixture-token', token_type: 'bearer' });
  it('refuses an oversized token reply', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(huge(256 * 1024)));
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
    expect(usage.reserve).not.toHaveBeenCalled();
  });
  it('refuses an oversized profile reply', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(token())
        .mockResolvedValueOnce(huge(256 * 1024)),
    );
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
  });
  it('maps a refused redirect on the token call to the provider failure, before any reservation', async () => {
    const fetcher = vi.fn().mockRejectedValue(redirectFailure());
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(usage.reserve).not.toHaveBeenCalled();
  });
  it('maps a refused redirect on /users/me to the provider failure and settles the reservation to zero', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(token()).mockRejectedValueOnce(redirectFailure());
    vi.stubGlobal('fetch', fetcher);
    const failure = await fetchXIdentity('code', 'verifier').catch((error) => error);
    expect(failure).toMatchObject({ code: 'provider' });
    expect(JSON.stringify(failure)).not.toContain('fixture-token');
    expect(usage.reserve).toHaveBeenCalledTimes(1);
    expect(usage.settle).toHaveBeenCalledWith('reservation', 0, expect.any(String));
  });
  it('settles the reservation to zero when the profile read answers with an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(token())
        .mockResolvedValueOnce(new Response('{}', { status: 503 })),
    );
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
    expect(usage.settle).toHaveBeenCalledWith('reservation', 0, expect.stringContaining('503'));
  });
  it('keeps the reservation when the profile reply was served but refused (oversized)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(token())
        .mockResolvedValueOnce(huge(256 * 1024)),
    );
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
    expect(usage.reserve).toHaveBeenCalledTimes(1);
    expect(usage.settle).not.toHaveBeenCalled();
  });
  it('keeps the reservation and reports the provider failure when the profile body times out', async () => {
    const stalled = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(stalled));
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
    expect(usage.reserve).toHaveBeenCalledTimes(1);
    expect(usage.settle).not.toHaveBeenCalled();
  });
  it('keeps the reservation when the profile body breaks for any other reason', async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('terminated'));
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(broken));
    await expect(fetchXIdentity('code', 'verifier')).rejects.toMatchObject({ code: 'provider' });
    expect(usage.reserve).toHaveBeenCalledTimes(1);
    expect(usage.settle).not.toHaveBeenCalled();
  });
  it('keeps redirects refused on both calls', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(Response.json({ data: { id: '1', username: 'u', name: 'n' } }));
    vi.stubGlobal('fetch', fetcher);
    await fetchXIdentity('code', 'verifier');
    expect(fetcher.mock.calls.map((call) => call[1].redirect)).toEqual(['error', 'error']);
  });
});
