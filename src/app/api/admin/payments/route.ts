import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { recordRaidPayment } from '@/lib/raid-allocation';
import { failure } from '@/lib/http';
import { z } from 'zod';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser(true);
    await rateLimit(`payment:${user.id}`, 20, 60);
    const body = z
      .object({ id: z.string().max(80), signature: z.string().max(90) })
      .parse(await request.json());
    await recordRaidPayment(body.id, body.signature, user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
