import { z } from 'zod';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './auth-primitives';

const cid = z.string().regex(/^(?:bafy[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/);
export function ipfsUri(value: string) {
  const match = /^ipfs:\/\/(.+)$/.exec(value);
  if (!match) throw new HttpError(400, 'Invalid IPFS URI.');
  return `ipfs://${cid.parse(match[1])}`;
}
function proofKey(version: string) {
  const source = Buffer.from(process.env[`LAUNCH_KEY_${version}`] || '', 'base64');
  if (source.length !== 32) throw new HttpError(503, 'Upload verification unavailable.');
  return createHash('sha256').update(source).update('useRAID asset proof').digest();
}
export function signAsset(uri: string, kind: 'logo' | 'banner', userId: string) {
  const version = process.env.LAUNCH_KEY_VERSION || '1';
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const signature = createHmac('sha256', proofKey(version))
    .update(`${userId}:${kind}:${ipfsUri(uri)}:${expires}`)
    .digest('base64url');
  return `${version}.${expires}.${signature}`;
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
  const parsed = z.object({ data: z.object({ cid }) }).parse(await result.json());
  return `ipfs://${parsed.data.cid}`;
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
export async function validateImage(file: File, kind: 'logo' | 'banner') {
  if (file.size < 1 || file.size > 5 * 1024 * 1024)
    throw new HttpError(400, `${kind} must be under 5 MB.`);
  if (!sniffImage(new Uint8Array(await file.slice(0, 12).arrayBuffer())))
    throw new HttpError(400, `${kind} must be PNG, JPG, or GIF.`);
}
