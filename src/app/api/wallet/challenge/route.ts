import { NextResponse } from 'next/server';
import { checkOrigin, publicRateLimit } from '@/lib/auth';
import { createWalletChallenge } from '@/lib/wallet-auth';
import { z } from 'zod';
import { failure, readJson } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await publicRateLimit(request, 'wallet-challenge', 20, 600, 400);
    const { address } = await readJson(request, z.object({ address: z.string().max(64) }));
    return NextResponse.json(await createWalletChallenge(address), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return failure(error);
  }
}
