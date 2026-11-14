import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit, HttpError } from '@/lib/auth';
import { pinFile, signAsset, validateImage } from '@/lib/launch-ipfs';
import { launchEnabled } from '@/lib/pump-launch';
import { failure, readBodyBytes } from '@/lib/http';
import { assertLaunchpadsAvailable } from '@/lib/release';
import { assertNewLaunchIntentsAllowed } from '@/lib/launch-route-state';
// Image ceiling (5 MB, enforced by validateImage) plus room for multipart framing.
const LAUNCH_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;
export async function POST(request: Request) {
  try {
    assertLaunchpadsAvailable();
    assertNewLaunchIntentsAllowed();
    checkOrigin(request);
    const user = await requireUser();
    if (!launchEnabled()) throw new HttpError(503, 'Token launches unavailable.');
    await rateLimit(`launch-upload:${user.id}`, 20, 3600);
    const body = await readBodyBytes(request, LAUNCH_UPLOAD_MAX_BYTES);
    // A malformed multipart body is the caller's error (400), not an outage.
    const form = await new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') || '' },
      body: body.buffer as ArrayBuffer,
    })
      .formData()
      .catch(() => null);
    if (!form) throw new HttpError(400, 'Image and kind required.');
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
