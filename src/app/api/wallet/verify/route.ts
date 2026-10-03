import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  checkOrigin,
  publicRateLimit,
  currentUser,
  cookieOptions,
  hash,
  HttpError,
} from '@/lib/auth';
import { rotateWallet, verifyWalletChallenge } from '@/lib/wallet-auth';
import { z } from 'zod';
import { failure, readJson } from '@/lib/http';
import { sessionCookie } from '@/lib/studio-mode';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await publicRateLimit(request, 'wallet-verify', 20, 600, 400);
    const { digest, address, signature, rotate } = await readJson(
      request,
      z.object({
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        address: z.string().max(64),
        signature: z.string().max(128),
        rotate: z.boolean().optional(),
      }),
    );
    const user = await currentUser();
    if (rotate) {
      if (!user) throw new HttpError(401, 'Sign in to change your wallet.');
      await rotateWallet(user.id, digest, signature, address);
      return NextResponse.json({ address }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const raw = (await cookies()).get(sessionCookie())?.value;
    const token = await verifyWalletChallenge(
      digest,
      signature,
      address,
      user?.id,
      raw ? hash(raw) : undefined,
    );
    const response = NextResponse.json({ address }, { headers: { 'Cache-Control': 'no-store' } });
    response.cookies.set(sessionCookie(), token, { ...cookieOptions, maxAge: 7 * 86400 });
    return response;
  } catch (error) {
    return failure(error);
  }
}
