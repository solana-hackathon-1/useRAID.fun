import { NextResponse } from 'next/server';
import { checkOrigin, requireUser } from '@/lib/auth';
import { resolveTracking, carryHeldFunds } from '@/lib/tracking-review';
import { failure } from '@/lib/http';
import { z } from 'zod';
const input = z.object({
  action: z.enum([
    'clear',
    'exclude',
    'restore',
    'refresh',
    'reject-dispute',
    'resolve-dispute',
    'import-post',
    'carry-held',
  ]),
  reason: z.string().min(1).max(2000),
  postId: z.string().optional(),
  disputeId: z.string().optional(),
  targetRaidId: z.string().optional(),
});
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser(true);
    const body = input.parse(await request.json());
    if (body.action === 'carry-held')
      await carryHeldFunds((await params).id, body.targetRaidId || '', user.id, body.reason);
    else await resolveTracking((await params).id, user.id, { ...body, action: body.action });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
