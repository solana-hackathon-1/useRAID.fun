import { NextResponse } from 'next/server';
import { checkOrigin, requireUser } from '@/lib/auth';
import { submitLaunch } from '@/lib/pump-launch';
import { failure } from '@/lib/http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    const { transaction } = await request.json();
    return NextResponse.json(await submitLaunch((await params).id, user.id, transaction));
  } catch (error) {
    return failure(error);
  }
}
