import { checkOrigin, requireUser, rateLimit, HttpError } from '@/lib/auth';
import { validateImage } from '@/lib/launch-ipfs';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`studio-image:${user.id}`, 10, 60);
    const file = (await request.formData()).get('file');
    if (!(file instanceof File) || file.size > 256000)
      throw new HttpError(400, 'Choose a PNG, JPG, or GIF under 250 KB.');
    await validateImage(file, 'logo');
    const bytes = Buffer.from(await file.arrayBuffer());
    const mime = bytes[0] === 137 ? 'image/png' : bytes[0] === 255 ? 'image/jpeg' : 'image/gif';
    return Response.json({ imageUri: `data:${mime};base64,${bytes.toString('base64')}` });
  } catch (error) {
    return failure(error);
  }
}
