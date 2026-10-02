import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ipfsUri,
  pinMetadata,
  signAsset,
  validateImage,
  verifyAsset,
} from '../src/lib/launch-ipfs';

const logo = 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyvu';
const other = 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyva';
const previous = process.env.LAUNCH_KEY_1;
const rawCid = 'bafkreie7ohywtosou76tasm7j63yigtzxe7d5zqus4zu3j6oltvgtibeom';
describe('server-verified launch images', () => {
  beforeAll(() => {
    process.env.LAUNCH_KEY_1 = Buffer.alloc(32, 7).toString('base64');
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.LAUNCH_KEY_1;
    else process.env.LAUNCH_KEY_1 = previous;
  });
  it.each([logo, `ipfs://${rawCid}`, 'ipfs://QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n'])(
    'accepts valid IPFS CID: %s',
    (uri) => {
      expect(ipfsUri(uri)).toBe(uri);
      const proof = signAsset(uri, 'logo', 'owner');
      expect(() => verifyAsset(uri, 'logo', 'owner', proof)).not.toThrow();
    },
  );
  it.each([
    'ipfs://bafy' + 'a'.repeat(20),
    'ipfs://bafk-invalid',
    `ipfs://${rawCid}/metadata.json`,
    `ipfs://${rawCid}?download=true`,
    `https://gateway.pinata.cloud/ipfs/${rawCid}`,
  ])('rejects malformed CID or unsupported URI: %s', (uri) => {
    expect(() => ipfsUri(uri)).toThrow('Invalid IPFS URI.');
  });
  it('accepts raw CID returned by metadata upload during launch preparation', async () => {
    const previousJwt = process.env.PINATA_JWT;
    process.env.PINATA_JWT = 'test-jwt';
    const upload = vi.fn().mockResolvedValue(Response.json({ data: { cid: rawCid } }));
    vi.stubGlobal('fetch', upload);
    try {
      await expect(pinMetadata({ name: 'Test token', symbol: 'TEST', image: logo })).resolves.toBe(
        `ipfs://${rawCid}`,
      );
      const form = upload.mock.calls[0][1].body as FormData;
      expect(form.get('network')).toBe('public');
      const file = form.get('file') as File;
      expect(file.name).toBe('metadata.json');
      expect(JSON.parse(await file.text())).toEqual({
        name: 'Test token',
        symbol: 'TEST',
        image: logo,
      });
    } finally {
      vi.unstubAllGlobals();
      if (previousJwt === undefined) delete process.env.PINATA_JWT;
      else process.env.PINATA_JWT = previousJwt;
    }
  });
  it('reports malformed provider CIDs as upload failures', async () => {
    const previousJwt = process.env.PINATA_JWT;
    process.env.PINATA_JWT = 'test-jwt';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ data: { cid: 'bafy' + 'a'.repeat(20) } })),
    );
    try {
      await expect(pinMetadata({ name: 'Test token' })).rejects.toMatchObject({
        status: 503,
        message: 'IPFS upload returned an invalid CID. Please try again.',
      });
    } finally {
      vi.unstubAllGlobals();
      if (previousJwt === undefined) delete process.env.PINATA_JWT;
      else process.env.PINATA_JWT = previousJwt;
    }
  });
  it('binds uploaded CID to user, image kind, and expiry', () => {
    const proof = signAsset(logo, 'logo', 'owner');
    expect(() => verifyAsset(logo, 'logo', 'owner', proof)).not.toThrow();
    expect(() => verifyAsset(logo, 'banner', 'owner', proof)).toThrow();
    expect(() => verifyAsset(logo, 'logo', 'other-owner', proof)).toThrow();
    expect(() => verifyAsset(other, 'logo', 'owner', proof)).toThrow();
    const [version, , signature] = proof.split('.');
    expect(() => verifyAsset(logo, 'logo', 'owner', `${version}.1.${signature}`)).toThrow();
  });
  it('rejects content that only claims to be a valid image', async () => {
    await expect(
      validateImage(new File(['not PNG'], 'logo.png', { type: 'image/png' }), 'logo'),
    ).rejects.toThrow();
    await expect(
      validateImage(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.gif'), 'banner'),
    ).rejects.toThrow();
  });
});
