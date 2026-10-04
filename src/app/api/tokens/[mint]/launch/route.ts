import { NextResponse } from 'next/server';
import { currentUser, publicRateLimit } from '@/lib/auth';
import { meteoraTokenView } from '@/lib/meteora/view';
import { failure } from '@/lib/http';
export async function GET(request: Request, { params }: { params: Promise<{ mint: string }> }) {
  try {
    await publicRateLimit(request, 'launch-view', 120, 60, 6000);
    const user = await currentUser();
    const view = await meteoraTokenView((await params).mint, user?.id, true);
    return NextResponse.json(view || { error: 'Launch not found.' }, {
      status: view ? 200 : 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (e) {
    return failure(e);
  }
}
