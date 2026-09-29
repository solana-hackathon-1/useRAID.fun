import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { prepareLaunch } from '@/lib/pump-launch';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`launch:${user.id}`, 5, 3600);
    return NextResponse.json(await prepareLaunch(user.id, await request.json()), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
