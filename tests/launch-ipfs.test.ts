import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ipfsUri,
  pinMetadata,
  sniffImage,
  signAsset,
  validateImage,
  verifyAsset,
} from '../src/lib/launch-ipfs';

const logo = 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyvu';
const other = 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyva';
const previous = process.env.LAUNCH_ASSET_KEY;
const previousLaunchKey = process.env.LAUNCH_KEY_1;
const rawCid = 'bafkreie7ohywtosou76tasm7j63yigtzxe7d5zqus4zu3j6oltvgtibeom';
describe('server-verified launch images', () => {
  beforeAll(() => {
    process.env.LAUNCH_ASSET_KEY = Buffer.alloc(32, 7).toString('base64');
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.LAUNCH_ASSET_KEY;
    else process.env.LAUNCH_ASSET_KEY = previous;
    if (previousLaunchKey === undefined) delete process.env.LAUNCH_KEY_1;
    else process.env.LAUNCH_KEY_1 = previousLaunchKey;
  });
  it('is not derived from the launch encryption key', () => {
    const proof = signAsset(logo, 'logo', 'owner');
    delete process.env.LAUNCH_ASSET_KEY;
    process.env.LAUNCH_KEY_1 = Buffer.alloc(32, 7).toString('base64');
    expect(() => verifyAsset(logo, 'logo', 'owner', proof)).toThrow(/unavailable/);
    expect(() => signAsset(logo, 'logo', 'owner')).toThrow(/unavailable/);
    process.env.LAUNCH_ASSET_KEY = Buffer.alloc(32, 7).toString('base64');
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
describe('sniffImage', () => {
  const bytes = (...values: number[]) => new Uint8Array(values);
  const ascii = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));
  it('recognises PNG, JPEG and both GIF headers from magic bytes', () => {
    expect(sniffImage(bytes(137, 80, 78, 71, 13, 10, 26, 10, 0))).toBe('image/png');
    expect(sniffImage(bytes(255, 216, 255, 224))).toBe('image/jpeg');
    expect(sniffImage(ascii('GIF87a....'))).toBe('image/gif');
    expect(sniffImage(ascii('GIF89a....'))).toBe('image/gif');
  });
  it('rejects everything else', () => {
    expect(sniffImage(ascii('<svg xmlns='))).toBeNull();
    expect(sniffImage(ascii('GIF90a'))).toBeNull();
    expect(sniffImage(bytes(137, 80))).toBeNull();
    expect(sniffImage(bytes())).toBeNull();
  });
});

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes: number[]) => {
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chars = (text: string) => [...text].map((c) => c.charCodeAt(0));
const chunk = (type: string, data: number[], badCrc = false) => {
  const body = [...chars(type), ...data];
  return [...u32(data.length), ...body, ...u32(badCrc ? crc(body) ^ 1 : crc(body))];
};
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const ihdr = (width: number, height: number) => [...u32(width), ...u32(height), 8, 2, 0, 0, 0];
const png = (
  options: {
    width?: number;
    height?: number;
    badCrc?: boolean;
    extra?: number[];
    text?: boolean;
  } = {},
) =>
  new Uint8Array([
    ...SIGNATURE,
    ...chunk('IHDR', ihdr(options.width ?? 1, options.height ?? 1), options.badCrc),
    ...(options.text ? chunk('tEXt', chars('Comment\0secret-location')) : []),
    ...chunk('IDAT', [0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1]),
    ...chunk('IEND', []),
    ...(options.extra ?? []),
  ]);
const file = (bytes: Uint8Array, name = 'x.png') => new File([bytes as BlobPart], name);
const segment = (marker: number, data: number[]) => [
  0xff,
  marker,
  (data.length + 2) >> 8,
  (data.length + 2) & 255,
  ...data,
];
const jpeg = (options: { exif?: boolean; end?: boolean; width?: number } = {}) => {
  const width = options.width ?? 1;
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, [...chars('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(options.exif ? segment(0xe1, [...chars('Exif'), 0, 0, 1, 2, 3, 4]) : []),
    ...segment(0xc0, [8, 0, 1, width >> 8, width & 255, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    ...[0x12, 0xff, 0x00, 0x34],
    ...(options.end === false ? [] : [0xff, 0xd9]),
  ]);
};
const gif = (trailer = true) =>
  new Uint8Array(
    [...chars('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x3b].slice(0, trailer ? undefined : -1),
  );

describe('structural image validation', () => {
  it('accepts a minimal PNG and reports its size', async () => {
    const result = await validateImage(file(png()), 'logo');
    expect(result).toMatchObject({ width: 1, height: 1, mime: 'image/png', ext: 'png' });
  });
  it('rejects a bad CRC, trailing bytes, an oversized header and a polyglot', async () => {
    await expect(validateImage(file(png({ badCrc: true })), 'logo')).rejects.toThrow();
    await expect(validateImage(file(png({ extra: [80, 75, 3, 4] })), 'logo')).rejects.toThrow();
    await expect(validateImage(file(png({ width: 5000 })), 'logo')).rejects.toThrow();
    const html = new Uint8Array([...SIGNATURE, ...chars('<html><script>alert(1)</script>')]);
    await expect(validateImage(file(html), 'logo')).rejects.toThrow();
  });
  it('strips PNG text metadata', async () => {
    const result = await validateImage(file(png({ text: true })), 'banner');
    expect(Buffer.from(result.bytes).toString('latin1')).not.toContain('secret-location');
    expect(result.bytes.length).toBeLessThan(png({ text: true }).length);
  });
  it('accepts a JPEG with Exif and removes the Exif segment', async () => {
    const result = await validateImage(file(jpeg({ exif: true }), 'x.jpg'), 'logo');
    expect(result).toMatchObject({ width: 1, height: 1, mime: 'image/jpeg', ext: 'jpg' });
    expect(Buffer.from(result.bytes).includes(Buffer.from('Exif'))).toBe(false);
    expect(Buffer.from(result.bytes).includes(Buffer.from('JFIF'))).toBe(true);
    expect([...result.bytes.slice(-2)]).toEqual([0xff, 0xd9]);
  });
  it('rejects a JPEG without an end marker or beyond the size limit', async () => {
    await expect(validateImage(file(jpeg({ end: false })), 'logo')).rejects.toThrow();
    await expect(validateImage(file(jpeg({ width: 5000 })), 'logo')).rejects.toThrow();
  });
  it('requires the GIF trailer', async () => {
    await expect(validateImage(file(gif()), 'logo')).resolves.toMatchObject({ mime: 'image/gif' });
    await expect(validateImage(file(gif(false)), 'logo')).rejects.toThrow();
  });
});
