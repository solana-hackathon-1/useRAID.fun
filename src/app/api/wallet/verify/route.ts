import { NextResponse } from 'next/server';
import { checkOrigin, clientKey, rateLimit, currentUser, cookieOptions } from '@/lib/auth';
import { verifyWalletChallenge } from '@/lib/wallet-auth';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await rateLimit(`wallet-verify:${clientKey(request)}`, 20, 600);
    const { digest, address, signature } = await request.json();
    const user = await currentUser();
    const token = await verifyWalletChallenge(digest, signature, address, user?.id);
    const response = NextResponse.json({ address }, { headers: { 'Cache-Control': 'no-store' } });
    response.cookies.set('raid_session', token, { ...cookieOptions, maxAge: 7 * 86400 });
    return response;
  } catch (error) {
    return failure(error);
  }
}
