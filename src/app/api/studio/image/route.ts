import { checkOrigin, requireUser, rateLimit, HttpError } from '@/lib/auth';
import { validateImage } from '@/lib/launch-ipfs';
import { MEDIA_MAX_BYTES, storeImage } from '@/lib/media';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`studio-image:${user.id}`, 10, 60);
    const file = (await request.formData()).get('file');
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
