import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { prepareLaunch } from '@/lib/pump-launch';
import { prepareMeteoraLaunch } from '@/lib/meteora/launch';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`launch:${user.id}`, 5, 3600);
    const body = await request.json();
    return NextResponse.json(body.provider === 'METEORA' ? await prepareMeteoraLaunch(user.id, body) : await prepareLaunch(user.id, body), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
