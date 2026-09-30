import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { openDispute } from '@/lib/tracking-review';
import { failure } from '@/lib/http';
import { z } from 'zod';
const input = z.object({
  category: z.enum(['MISSING_POST', 'EXCLUSION', 'METRICS', 'IDENTITY']),
  reason: z.string().min(1).max(2000),
  postId: z.string().regex(/^\d+$/).optional(),
});
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`dispute:${user.id}`, 10, 3600);
    return NextResponse.json(
      await openDispute((await params).id, user.id, input.parse(await request.json())),
      { status: 201 },
    );
  } catch (error) {
    return failure(error);
  }
}
