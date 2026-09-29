import { NextResponse } from 'next/server';
import { getToken } from '@/lib/data';
import { failure } from '@/lib/http';
import { publicRewardView } from '@/lib/reward-view';
import { currentUser } from '@/lib/auth';
export async function GET(_: Request, { params }: { params: Promise<{ mint: string }> }) {
  try {
    const mint = (await params).mint;
    const token = await getToken(mint);
    const user = await currentUser();
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
