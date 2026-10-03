import { createHash } from 'node:crypto';
import { db } from './db';
import { HttpError } from './auth-primitives';
import { sniffImage } from './launch-ipfs';

export const MEDIA_MAX_BYTES = 256000;
export const MEDIA_PATH = /^\/api\/media\/[a-z0-9]{20,40}$/;
const DATA_URI = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

export async function storeImage(bytes: Uint8Array, uploaderId: string | null) {
  const mime = sniffImage(bytes);
  if (!mime || bytes.length < 1 || bytes.length > MEDIA_MAX_BYTES)
    throw new HttpError(400, 'Choose a PNG, JPG, or GIF under 250 KB.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const asset = await db.mediaAsset.upsert({
    where: { sha256 },
    create: { sha256, mime, bytes: Buffer.from(bytes), size: bytes.length, uploaderId },
    update: {},
    select: { id: true },
  });
  return `/api/media/${asset.id}`;
}
// Data URIs from drafts saved before images moved to MediaAsset; null when the value is not one.
export async function importDataUri(value: unknown, uploaderId: string | null) {
  const match = typeof value === 'string' && value.length <= 400000 ? DATA_URI.exec(value) : null;
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (sniffImage(bytes) !== `image/${match[1]}`) return null;
  return storeImage(bytes, uploaderId);
}
export async function backfillMedia() {
  let moved = 0,
    skipped = 0;
  const where = { imageUri: { startsWith: 'data:image/' } };
  for (const raid of await db.raid.findMany({ where, select: { id: true, imageUri: true } })) {
    const next = await importDataUri(raid.imageUri, null);
    if (!next) skipped++;
    else {
      await db.raid.update({ where: { id: raid.id }, data: { imageUri: next } });
      moved++;
    }
  }
  for (const token of await db.token.findMany({ where, select: { mint: true, imageUri: true } })) {
    const next = await importDataUri(token.imageUri, null);
    if (!next) skipped++;
    else {
      await db.token.update({ where: { mint: token.mint }, data: { imageUri: next } });
      moved++;
    }
  }
  return { moved, skipped };
}
