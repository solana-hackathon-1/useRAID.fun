import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { createRaid } from '@/lib/campaigns';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`create:${user.id}`, 10, 3600);
    return NextResponse.json(await createRaid(user, await request.json()), { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
