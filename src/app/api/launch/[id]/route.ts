import { NextResponse } from 'next/server';
import { requireUser, HttpError } from '@/lib/auth';
import { db } from '@/lib/db';
import { publicLaunch, reconcileLaunch } from '@/lib/pump-launch';
import { nextLaunchStep } from '@/lib/meteora/launch';
import { failure } from '@/lib/http';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const launch = await db.tokenLaunch.findUnique({ where: { id: (await params).id } });
    if (!launch || launch.userId !== user.id) throw new HttpError(404, 'Launch not found.');
    const result = launch.provider === 'METEORA' ? await nextLaunchStep(launch.id, user.id) :
      launch.status === 'SUBMITTED' ? await reconcileLaunch(launch.id) : publicLaunch(launch);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}
