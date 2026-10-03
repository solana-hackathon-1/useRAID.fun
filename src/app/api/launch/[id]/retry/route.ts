import { NextResponse } from 'next/server';
import { checkOrigin, requireUser } from '@/lib/auth';
import { buildLaunchTransaction } from '@/lib/pump-launch';
import { failure } from '@/lib/http';
import { assertLaunchpadsAvailable } from '@/lib/release';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertLaunchpadsAvailable();
    checkOrigin(request);
    const user = await requireUser();
    return NextResponse.json(await buildLaunchTransaction((await params).id, user.id));
  } catch (error) {
    return failure(error);
  }
}
