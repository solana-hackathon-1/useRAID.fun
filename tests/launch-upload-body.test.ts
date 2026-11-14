import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeRequest } from './helpers/route';

// #161 T091: the launch image upload must reject a malformed or oversized body with 4xx, never a 503.
const mocks = vi.hoisted(() => ({ pinFile: vi.fn(), validateImage: vi.fn() }));
vi.mock('../src/lib/release', () => ({ assertLaunchpadsAvailable: () => {} }));
vi.mock('../src/lib/launch-route-state', () => ({ assertNewLaunchIntentsAllowed: () => {} }));
vi.mock('../src/lib/pump-launch', () => ({ launchEnabled: () => true }));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: () => {},
  requireUser: async () => ({ id: 'u1' }),
  rateLimit: async () => {},
}));
vi.mock('../src/lib/launch-ipfs', () => ({
  pinFile: mocks.pinFile,
  signAsset: () => 'proof',
  validateImage: mocks.validateImage,
}));
import { POST as upload } from '../src/app/api/launch/upload/route';

const url = 'http://localhost/api/launch/upload';
beforeEach(() => vi.clearAllMocks());

describe('launch image upload body handling', () => {
  it('answers a malformed multipart body with 400 and pins nothing', async () => {
    const response = await upload(
      routeRequest(url, {
        rawBody: 'this is not multipart',
        headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.pinFile).not.toHaveBeenCalled();
  });

  it('answers a body with no content type with 400', async () => {
    const response = await upload(
      routeRequest(url, { rawBody: 'x', headers: { 'content-type': '' } }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses an invalid content-length header with 413 before reading', async () => {
    const response = await upload(
      routeRequest(url, {
        rawBody: 'x',
        headers: { 'content-type': 'multipart/form-data; boundary=xyz', 'content-length': 'abc' },
      }),
    );
    expect(response.status).toBe(413);
  });

  it('refuses an oversized body with 413', async () => {
    const response = await upload(
      routeRequest(url, {
        rawBody: 'x'.repeat(6 * 1024 * 1024 + 1),
        headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
      }),
    );
    expect(response.status).toBe(413);
  });

  it('still pins a valid image', async () => {
    mocks.validateImage.mockResolvedValue({
      bytes: new Uint8Array([1]),
      ext: 'png',
      mime: 'image/png',
    });
    mocks.pinFile.mockResolvedValue('ipfs://x');
    const form = new FormData();
    form.set('kind', 'logo');
    form.set('file', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }));
    const response = await upload(new Request(url, { method: 'POST', body: form }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uri: 'ipfs://x', proof: 'proof' });
  });
});
