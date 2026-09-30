import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { verifyRaidFunding } from '@/lib/raid-funding';
import { failure } from '@/lib/http';
import { z } from 'zod';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`fund:${user.id}`, 10, 60);
    const body = z.object({ signature: z.string().max(90) }).parse(await request.json());
    return NextResponse.json(await verifyRaidFunding((await params).id, user.id, body.signature));
  } catch (error) { return failure(error); }
}
