import { z } from 'zod';
import { checkOrigin, requireUser, rateLimit, HttpError } from '@/lib/auth';
import { createDeposit, verifyUsdcTransfer, requestWithdrawal, units } from '@/lib/usdc';
import { failure } from '@/lib/http';
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await rateLimit(`balance:${user.id}`, 20, 60);
    const body = await request.json(),
      { action } = await params;
    if (action === 'deposit')
      return Response.json(await createDeposit(user.id, units(z.string().parse(body.amount))));
    if (action === 'verify') {
      const data = z.object({ id: z.string().max(80), signature: z.string().max(110) }).parse(body);
      await verifyUsdcTransfer(data.id, data.signature, user.id);
      return Response.json({ ok: true });
    }
    if (action === 'withdraw') {
      const data = z.object({ amount: z.string(), key: z.string().max(80) }).parse(body);
      const transfer = await requestWithdrawal(user.id, units(data.amount), data.key);
      return Response.json({ id: transfer.id });
    }
    throw new HttpError(404, 'Balance action not found.');
  } catch (error) {
    return failure(error);
  }
}
