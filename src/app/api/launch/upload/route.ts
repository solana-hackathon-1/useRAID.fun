import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit, HttpError } from '@/lib/auth';
import { pinFile, signAsset, validateImage } from '@/lib/launch-ipfs';
import { launchEnabled } from '@/lib/pump-launch';
import { meteoraReadiness } from '@/lib/meteora/config';
import { failure } from '@/lib/http';
import { assertLaunchpadsAvailable } from '@/lib/release';
export async function POST(request: Request) {
  try {
    assertLaunchpadsAvailable();
    checkOrigin(request);
    const user = await requireUser();
    if (!launchEnabled() && !meteoraReadiness().enabled) throw new HttpError(503, 'Token launches unavailable.');
    await rateLimit(`launch-upload:${user.id}`, 20, 3600);
    if (Number(request.headers.get('content-length') || 0) > 6 * 1024 * 1024)
      throw new HttpError(413, 'Image too large.');
    if (!request.body) throw new HttpError(400, 'Image required.');
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 6 * 1024 * 1024) {
        await reader.cancel();
        throw new HttpError(413, 'Image too large.');
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const form = await new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') || '' },
      body: body.buffer,
    }).formData();
    const kind = form.get('kind');
    const file = form.get('file');
    if ((kind !== 'logo' && kind !== 'banner') || !(file instanceof File))
      throw new HttpError(400, 'Image and kind required.');
    const image = await validateImage(file, kind);
    const uri = await pinFile(
      new File([image.bytes], `${kind}.${image.ext}`, { type: image.mime }),
    );
    return NextResponse.json({ uri, proof: signAsset(uri, kind, user.id) });
  } catch (error) {
    return failure(error);
  }
}
