import { db } from '@/lib/db';
import { config } from '@/lib/config';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const asset =
    config.demo || !/^[a-z0-9]{20,40}$/.test(id)
      ? null
      : await db.mediaAsset.findUnique({ where: { id }, select: { bytes: true, mime: true } });
  if (!asset)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  // An asset's bytes never change once stored, so the id can be cached indefinitely.
  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      'Content-Type': asset.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}
