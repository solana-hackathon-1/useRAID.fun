import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit, HttpError } from '@/lib/auth';
import { db } from '@/lib/db';
import { postId } from '@/lib/domain';
import { lockTracking } from '@/lib/tracking';
import { failure } from '@/lib/http';
import { addStudioTarget } from '@/lib/studio-targets';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`brief:${user.id}`, 30, 60);
    const body = await request.json();
    const id = typeof body.url === 'string' ? postId(body.url) : null;
    if (!id) throw new HttpError(400, 'Enter a valid X post URL.');
    const raidId = (await params).id;
    const campaign = await db.raid.findUnique({
      where: { id: raidId },
      select: { studioVersion: true },
    });
    if (campaign?.studioVersion === 1)
      return NextResponse.json(await addStudioTarget(raidId, user.id, body.url));
    const result = await db.$transaction(async (tx) => {
      await lockTracking(tx, raidId);
      const raid = await tx.raid.findUnique({ where: { id: raidId } });
      if (!raid || raid.creatorId !== user.id || raid.hidden)
        throw new HttpError(404, 'Raid not found.');
      if (
        !['DRAFT', 'ACTIVE', 'SCHEDULED'].includes(raid.status) ||
        (raid.status === 'ACTIVE' && raid.endsAt <= new Date())
      )
        throw new HttpError(409, 'This Raid has ended.');
      if ((await tx.raidBriefPost.count({ where: { raidId } })) >= 100)
        throw new HttpError(409, 'Maximum 100 campaign posts.');
      return tx.raidBriefPost.upsert({
        where: { raidId_postId: { raidId, postId: id } },
        create: { raidId, postId: id },
        update: {},
      });
    });
    return NextResponse.json(result);
  } catch (error) {
    return failure(error);
  }
}
