import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { prepareLaunch } from '@/lib/pump-launch';
import { prepareMeteoraLaunch } from '@/lib/meteora/launch';
import { meteoraLaunchSwitch } from '@/lib/meteora/config';
import { failure, readJson } from '@/lib/http';
import { launchpadsAvailable, assertLaunchpadsAvailable } from '@/lib/release';
export async function POST(request: Request) {
  try {
    // Pump launches stay behind the release gate; Meteora has its own switch and readiness checks.
    if (!launchpadsAvailable && !meteoraLaunchSwitch()) assertLaunchpadsAvailable();
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`launch:${user.id}`, 5, 3600);
    const body = await readJson(request, z.object({ provider: z.string().optional() }).loose());
    if (body.provider === 'METEORA')
      return NextResponse.json(await prepareMeteoraLaunch(user.id, body), { status: 201 });
    assertLaunchpadsAvailable();
    return NextResponse.json(await prepareLaunch(user.id, body), { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
