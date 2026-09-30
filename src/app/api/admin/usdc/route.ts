import { z } from 'zod';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { verifyUsdcTransfer, rejectWithdrawal } from '@/lib/usdc';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser(true);
    await rateLimit(`usdc-admin:${user.id}`, 30, 60);
    const body = z
      .object({
        id: z.string().max(80),
        action: z.enum(['verify', 'reject']),
        signature: z.string().max(110).optional(),
        reason: z.string().min(5).max(500).optional(),
      })
      .parse(await request.json());
    if (body.action === 'verify')
      await verifyUsdcTransfer(body.id, body.signature || '', user.id, true);
    else await rejectWithdrawal(body.id, user.id, body.reason || '');
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
