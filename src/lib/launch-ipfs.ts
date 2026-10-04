import { z } from 'zod';
import { CID } from 'multiformats/cid';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './auth-primitives';

const cid = z.string().refine((value) => {
  try {
    CID.parse(value);
    return true;
  } catch {
    return false;
  }
}, 'Invalid IPFS CID.');
export function ipfsUri(value: string) {
  const match = /^ipfs:\/\/(.+)$/.exec(value);
  if (!match || !cid.safeParse(match[1]).success) throw new HttpError(400, 'Invalid IPFS URI.');
  return value;
}
const PROOF_VERSION = '1';
function proofKey(version: string) {
  const source = Buffer.from(process.env.LAUNCH_ASSET_KEY || '', 'base64');
  if (version !== PROOF_VERSION || source.length !== 32)
    throw new HttpError(503, 'Upload verification unavailable.');
  return createHash('sha256').update(source).update('useRAID asset proof').digest();
}
export function signAsset(uri: string, kind: 'logo' | 'banner', userId: string) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const signature = createHmac('sha256', proofKey(PROOF_VERSION))
    .update(`${userId}:${kind}:${ipfsUri(uri)}:${expires}`)
    .digest('base64url');
  return `${PROOF_VERSION}.${expires}.${signature}`;
}
export function verifyAsset(uri: string, kind: 'logo' | 'banner', userId: string, proof: string) {
  const match = /^(\d+)\.(\d+)\.([A-Za-z0-9_-]{43})$/.exec(proof);
  if (!match || Number(match[2]) <= Date.now() / 1000)
    throw new HttpError(400, 'Upload expired. Upload image again.');
  const expected = createHmac('sha256', proofKey(match[1]))
    .update(`${userId}:${kind}:${ipfsUri(uri)}:${match[2]}`)
    .digest();
  const actual = Buffer.from(match[3], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new HttpError(400, 'Image upload verification failed.');
}
export async function pinFile(file: File) {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) throw new HttpError(503, 'Media uploads unavailable.');
  const form = new FormData();
  form.append('file', file);
  form.append('network', 'public');
  const result = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
  });
  if (!result.ok) throw new HttpError(503, 'IPFS upload failed.');
  const parsed = z.object({ data: z.object({ cid }) }).safeParse(await result.json());
  if (!parsed.success)
    throw new HttpError(503, 'IPFS upload returned an invalid CID. Please try again.');
  return `ipfs://${parsed.data.data.cid}`;
}
export async function pinMetadata(data: Record<string, string | undefined>) {
  const file = new File([JSON.stringify(data)], 'metadata.json', { type: 'application/json' });
  return pinFile(file);
}
export function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | null {
  const png =
    bytes.length >= 8 &&
    bytes.slice(0, 8).every((b, i) => b === [137, 80, 78, 71, 13, 10, 26, 10][i]);
  const jpg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const head = String.fromCharCode(...bytes.slice(0, 6));
  const gif = head === 'GIF87a' || head === 'GIF89a';
  return png ? 'image/png' : jpg ? 'image/jpeg' : gif ? 'image/gif' : null;
}
const MAX_DIMENSION = 4096;
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const invalid = (kind: string) => new HttpError(400, `${kind} is not a valid image.`);
const inRange = (n: number) => n >= 1 && n <= MAX_DIMENSION;
const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(new ArrayBuffer(chunks.reduce((a, c) => a + c.length, 0)));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};
// Walks the container structure, rejects anything malformed or carrying trailing bytes, and drops metadata chunks.
function cleanPng(bytes: Uint8Array, kind: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
  const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const kept: Uint8Array[] = [bytes.slice(0, 8)];
  let offset = 8,
    width = 0,
    height = 0,
    idat = false,
    first = true;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw invalid(kind);
    const type = text(offset + 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) throw invalid(kind);
    if (first) {
      if (type !== 'IHDR' || length !== 13) throw invalid(kind);
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (!inRange(width) || !inRange(height)) throw invalid(kind);
      first = false;
    } else if (type === 'IHDR') throw invalid(kind);
    else if (type[0] >= 'A' && type[0] <= 'Z' && !['PLTE', 'IDAT', 'IEND'].includes(type))
      throw invalid(kind);
    if (type === 'IDAT') idat = true;
    if (!drop.has(type)) kept.push(bytes.slice(offset, end));
    offset = end;
    if (type === 'IEND') {
      if (offset !== bytes.length || !idat) throw invalid(kind);
      return { bytes: concat(kept), width, height };
    }
  }
  throw invalid(kind);
}
function cleanJpeg(bytes: Uint8Array, kind: string) {
  const kept: Uint8Array[] = [bytes.slice(0, 2)];
  let offset = 2,
    width = 0,
    height = 0,
    frame = false,
    scanned = false;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) throw invalid(kind);
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd9) {
      if (!scanned || offset + 2 !== bytes.length) throw invalid(kind);
      kept.push(bytes.slice(offset, offset + 2));
      return { bytes: concat(kept), width, height };
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8))
      throw invalid(kind);
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) throw invalid(kind);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      if (!inRange(width) || !inRange(height)) throw invalid(kind);
      frame = true;
    }
    if (!((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe))
      kept.push(bytes.slice(offset, end));
    offset = end;
    if (marker === 0xda) {
      if (!frame) throw invalid(kind);
      scanned = true;
      const start = offset;
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) offset++;
        else if (bytes[offset + 1] === 0xff) offset++;
        else if (
          bytes[offset + 1] === 0x00 ||
          (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)
        )
          offset += 2;
        else break;
      }
      kept.push(bytes.slice(start, offset));
    }
  }
  throw invalid(kind);
}
function checkGif(bytes: Uint8Array, kind: string) {
  if (bytes.length < 14 || bytes[bytes.length - 1] !== 0x3b) throw invalid(kind);
  const width = bytes[6] | (bytes[7] << 8),
    height = bytes[8] | (bytes[9] << 8);
  if (!inRange(width) || !inRange(height)) throw invalid(kind);
  return { bytes, width, height };
}
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' } as const;
export async function validateImage(file: File, kind: 'logo' | 'banner') {
  if (file.size < 1 || file.size > 5 * 1024 * 1024)
    throw new HttpError(400, `${kind} must be under 5 MB.`);
  const original = new Uint8Array(await file.arrayBuffer());
  const mime = sniffImage(original);
  if (!mime) throw new HttpError(400, `${kind} must be PNG, JPG, or GIF.`);
  const parsed =
    mime === 'image/png'
      ? cleanPng(original, kind)
      : mime === 'image/jpeg'
        ? cleanJpeg(original, kind)
        : checkGif(original, kind);
  return { ...parsed, bytes: new Uint8Array(parsed.bytes), mime, ext: EXTENSIONS[mime] };
}
