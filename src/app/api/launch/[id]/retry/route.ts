import { NextResponse } from 'next/server';
import { checkOrigin, requireUser } from '@/lib/auth';
import { buildLaunchTransaction } from '@/lib/pump-launch';
import { nextLaunchStep } from '@/lib/meteora/launch';
import { db } from '@/lib/db';
import { failure } from '@/lib/http';
import { assertLaunchpadsAvailable } from '@/lib/release';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertLaunchpadsAvailable();
    checkOrigin(request);
    const user = await requireUser();
    const id = (await params).id;
    const launch = await db.tokenLaunch.findUnique({ where: { id } });
    return NextResponse.json(launch?.provider === 'METEORA' ? await nextLaunchStep(id, user.id) : await buildLaunchTransaction(id, user.id));
  } catch (error) {
    return failure(error);
  }
}
