import { NextResponse } from 'next/server';
import { getToken } from '@/lib/data';
import { config } from '@/lib/config';
import { failure } from '@/lib/http';
import { publicRewardView } from '@/lib/reward-view';
import { currentUser, publicRateLimit } from '@/lib/auth';
import { meteoraTokenView } from '@/lib/meteora/view';
export async function GET(request: Request, { params }: { params: Promise<{ mint: string }> }) {
  try {
    if (!config.demo) await publicRateLimit(request, 'token-view', 120, 60, 6000);
    const mint = (await params).mint;
    const user = await currentUser();
    const launch = config.demo ? null : await meteoraTokenView(mint, user?.id, true);
    if (launch)
      return NextResponse.json(launch, { headers: { 'Cache-Control': 'private, no-store' } });
    const token = await getToken(mint);
    return NextResponse.json(
      token
        ? { ...token, rewards: await publicRewardView(mint, user?.id) }
        : { error: 'Token not found' },
      { status: token ? 200 : 404 },
    );
  } catch (e) {
    return failure(e);
  }
}
