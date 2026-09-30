import { submitTrackingPost } from '@/lib/tracking';
import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, clientKey, rateLimit, HttpError } from '@/lib/auth';
import { db } from '@/lib/db';
import { postId } from '@/lib/domain';
import { enqueue } from '@/lib/queue';
import { failure } from '@/lib/http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    await rateLimit(`submit:${clientKey(request)}`, 10, 3600);
    const id = postId((await request.json()).url);
    if (!id) throw new HttpError(400, 'Enter an https://x.com/.../status/... post URL.');
    const raid = await db.raid.findUnique({
      where: { id: (await params).id },
      include: { creator: true },
    });
    if (raid?.trackingVersion === 2) {
      const user = await requireUser();
      await rateLimit(`submissions:user:${user.id}`, 20, 3600);
      await rateLimit(`submissions:raid:${raid.id}`, 50, 3600);
      const submission = await submitTrackingPost(raid.id, user.id, id);
      return NextResponse.json(
        {
          id: submission.id,
          postId: submission.postId,
          status: submission.status,
          reasonCode: submission.reasonCode,
          message: 'Post queued for identity and qualification checks.',
        },
        { status: submission.status === 'QUEUED' ? 202 : 200 },
      );
    }
    if (
      !raid ||
      raid.hidden ||
      raid.creator.suspended ||
      raid.status !== 'ACTIVE' ||
      raid.endsAt < new Date()
    )
      throw new HttpError(400, 'This raid is not accepting posts.');
    await rateLimit(`submissions:raid:${raid.id}`, 50, 3600);
    await enqueue('submission', `submission:${raid.id}:${id}`, { raidId: raid.id, postId: id });
    return NextResponse.json(
      {
        ok: true,
        message: 'Post queued for attribution checks. Only qualifying posts will appear.',
      },
      { status: 202 },
    );
  } catch (e) {
    return failure(e);
  }
}
