import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { prepareLaunch } from '@/lib/pump-launch';
import { failure, readJsonBody } from '@/lib/http';
import { assertLaunchpadsAvailable } from '@/lib/release';
import { assertNewLaunchIntentsAllowed } from '@/lib/launch-route-state';
export async function POST(request: Request) {
  try {
    assertLaunchpadsAvailable();
    assertNewLaunchIntentsAllowed();
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`launch:${user.id}`, 5, 3600);
    return NextResponse.json(await prepareLaunch(user.id, await readJsonBody(request)), {
      status: 201,
    });
  } catch (error) {
    return failure(error);
  }
}
