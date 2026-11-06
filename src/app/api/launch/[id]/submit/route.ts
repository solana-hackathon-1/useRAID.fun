import { NextResponse } from 'next/server';
import { checkOrigin, requireUser } from '@/lib/auth';
import { submitLaunch } from '@/lib/pump-launch';
import { failure, readJsonBody } from '@/lib/http';
import { assertLaunchpadsAvailable } from '@/lib/release';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertLaunchpadsAvailable();
    checkOrigin(request);
    const user = await requireUser();
    const { transaction } = await readJsonBody(request);
    return NextResponse.json(await submitLaunch((await params).id, user.id, transaction));
  } catch (error) {
    return failure(error);
  }
}
