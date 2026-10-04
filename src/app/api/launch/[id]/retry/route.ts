import { NextResponse } from 'next/server';
import { checkOrigin, requireUser } from '@/lib/auth';
import { buildLaunchTransaction } from '@/lib/pump-launch';
import { nextLaunchStep } from '@/lib/meteora/launch';
import { meteoraLaunchSwitch } from '@/lib/meteora/config';
import { db } from '@/lib/db';
import { failure } from '@/lib/http';
import { launchpadsAvailable, assertLaunchpadsAvailable } from '@/lib/release';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Pump launches stay behind the release gate; Meteora has its own switch and readiness checks.
    if (!launchpadsAvailable && !meteoraLaunchSwitch()) assertLaunchpadsAvailable();
    checkOrigin(request);
    const user = await requireUser();
    const id = (await params).id;
    const launch = await db.tokenLaunch.findUnique({ where: { id } });
    if (launch?.provider === 'METEORA') return NextResponse.json(await nextLaunchStep(id, user.id));
    assertLaunchpadsAvailable();
    return NextResponse.json(await buildLaunchTransaction(id, user.id));
  } catch (error) {
    return failure(error);
  }
}
