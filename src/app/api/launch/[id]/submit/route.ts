import { NextResponse } from 'next/server';
import { checkOrigin, requireUser } from '@/lib/auth';
import { submitLaunch } from '@/lib/pump-launch';
import { submitMeteoraLaunch } from '@/lib/meteora/launch';
import { db } from '@/lib/db';
import { failure } from '@/lib/http';
import { assertLaunchpadsAvailable } from '@/lib/release';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertLaunchpadsAvailable();
    checkOrigin(request);
    const user = await requireUser();
    const { transaction, stepId } = await request.json();
    const id = (await params).id;
    const launch = await db.tokenLaunch.findUnique({ where: { id } });
    return NextResponse.json(launch?.provider === 'METEORA' ? await submitMeteoraLaunch(id, user.id, stepId, transaction) : await submitLaunch(id, user.id, transaction));
  } catch (error) {
    return failure(error);
  }
}
