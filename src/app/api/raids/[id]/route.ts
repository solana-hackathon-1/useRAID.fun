import { NextResponse } from 'next/server';
import { checkOrigin, requireUser } from '@/lib/auth';
import { changeRaid } from '@/lib/campaigns';
import { getRaid } from '@/lib/data';
import { failure } from '@/lib/http';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const raid = await getRaid((await params).id);
    return NextResponse.json(raid || { error: 'Raid not found' }, { status: raid ? 200 : 404 });
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    const body = await request.json();
    return NextResponse.json(await changeRaid(user, (await params).id, body.action));
  } catch (e) {
    return failure(e);
  }
}
