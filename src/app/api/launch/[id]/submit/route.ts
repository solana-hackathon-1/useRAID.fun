import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkOrigin, requireUser } from '@/lib/auth';
import { submitLaunch } from '@/lib/pump-launch';
import { submitMeteoraLaunch } from '@/lib/meteora/launch';
import { meteoraLaunchSwitch } from '@/lib/meteora/config';
import { db } from '@/lib/db';
import { failure, readJson } from '@/lib/http';
import { launchpadsAvailable, assertLaunchpadsAvailable } from '@/lib/release';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Pump launches stay behind the release gate; Meteora has its own switch and readiness checks.
    if (!launchpadsAvailable && !meteoraLaunchSwitch()) assertLaunchpadsAvailable();
    checkOrigin(request);
    const user = await requireUser();
    const { transaction, stepId } = await readJson(
      request,
      z.object({ transaction: z.string().min(1), stepId: z.string().optional() }),
    );
    const id = (await params).id;
    const launch = await db.tokenLaunch.findUnique({ where: { id } });
    if (launch?.provider === 'METEORA')
      return NextResponse.json(await submitMeteoraLaunch(id, user.id, stepId ?? '', transaction));
    assertLaunchpadsAvailable();
    return NextResponse.json(await submitLaunch(id, user.id, transaction));
  } catch (error) {
    return failure(error);
  }
}
