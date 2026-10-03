import { NextResponse } from 'next/server';
import { checkOrigin, publicRateLimit, currentUser, HttpError } from '@/lib/auth';
import { createWalletChallenge } from '@/lib/wallet-auth';
import { z } from 'zod';
import { failure, readJson } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await publicRateLimit(request, 'wallet-challenge', 20, 600, 400);
    const { address, rotate } = await readJson(
      request,
      z.object({ address: z.string().max(64), rotate: z.boolean().optional() }),
    );
    const user = await currentUser();
    if (rotate && !user) throw new HttpError(401, 'Sign in to change your wallet.');
    return NextResponse.json(
      await createWalletChallenge(address, user?.id, rotate ? 'rotate' : undefined),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return failure(error);
  }
}
