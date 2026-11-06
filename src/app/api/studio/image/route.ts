import { checkOrigin, requireUser, rateLimit, HttpError } from '@/lib/auth';
import { validateImage } from '@/lib/launch-ipfs';
import { MEDIA_MAX_BYTES, storeImage } from '@/lib/media';
import { failure, readBodyBytes } from '@/lib/http';
// The image ceiling plus room for multipart framing; a larger body is refused before it is buffered.
const BODY_MAX_BYTES = MEDIA_MAX_BYTES + 16 * 1024;
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`studio-image:${user.id}`, 10, 60);
    const body = await readBodyBytes(request, BODY_MAX_BYTES);
    const form = await new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') || '' },
      body: body.buffer as ArrayBuffer,
    })
      .formData()
      .catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File) || file.size > MEDIA_MAX_BYTES)
      throw new HttpError(400, 'Choose a PNG, JPG, or GIF under 250 KB.');
    await validateImage(file, 'logo');
    return Response.json({
      imageUri: await storeImage(new Uint8Array(await file.arrayBuffer()), user.id),
    });
  } catch (error) {
    return failure(error);
  }
}
