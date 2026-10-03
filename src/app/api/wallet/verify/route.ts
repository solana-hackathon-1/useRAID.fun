import { NextResponse } from 'next/server';
import { checkOrigin, publicRateLimit, currentUser, cookieOptions } from '@/lib/auth';
import { verifyWalletChallenge } from '@/lib/wallet-auth';
import { z } from 'zod';
import { failure, readJson } from '@/lib/http';
import { sessionCookie } from '@/lib/studio-mode';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await publicRateLimit(request, 'wallet-verify', 20, 600, 400);
    const { digest, address, signature } = await readJson(
      request,
      z.object({
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        address: z.string().max(64),
        signature: z.string().max(128),
      }),
    );
    const user = await currentUser();
    const token = await verifyWalletChallenge(digest, signature, address, user?.id);
    const response = NextResponse.json({ address }, { headers: { 'Cache-Control': 'no-store' } });
    response.cookies.set(sessionCookie(), token, { ...cookieOptions, maxAge: 7 * 86400 });
    return response;
  } catch (error) {
    return failure(error);
  }
}
