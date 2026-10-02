import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { createRaid } from '@/lib/campaigns';
import { failure } from '@/lib/http';
import { saveStudioRaid } from '@/lib/studio-campaigns';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`create:${user.id}`, 10, 3600);
    const input = await request.json();
    return NextResponse.json(
      input.studioVersion === 1 ? await saveStudioRaid(user, input) : await createRaid(user, input),
      { status: 201 },
    );
  } catch (e) {
    return failure(e);
  }
}
