import { requireUser, rateLimit, HttpError } from '@/lib/auth';
import { chargeStudioLookups, targetIds, targetPreviews } from '@/lib/studio-targets';
import { fetchMarket } from '@/lib/providers/market';
import { studioSandbox } from '@/lib/usdc';
import { validMint } from '@/lib/domain';
import { failure } from '@/lib/http';
import { db } from '@/lib/db';
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    await rateLimit(`studio-preview:${user.id}`, 30, 60);
    const query = new URL(request.url).searchParams;
    if (query.get('type') === 'post') {
      if (user.suspended || !(await db.xAccount.findUnique({ where: { userId: user.id } })))
        throw new HttpError(403, 'Connect X to preview posts.');
      const id = targetIds([query.get('url') || ''])[0];
      await chargeStudioLookups(user.id, 1);
      const preview = (await targetPreviews([id]))[0];
      if (!preview) throw new HttpError(404, 'Post unavailable. Choose a public X post.');
      return Response.json(preview);
    }
    const mint = query.get('mint') || '';
    if (!validMint(mint)) throw new HttpError(400, 'Enter a valid Solana contract address.');
    if (studioSandbox())
      return Response.json({ mint, name: 'Community Token', symbol: 'RAID', imageUri: null });
    const market = await fetchMarket(mint);
    return Response.json({
      mint,
      name: market?.name || '',
      symbol: market?.symbol || '',
      imageUri: market?.imageUri || null,
    });
  } catch (error) {
    return failure(error);
  }
}
