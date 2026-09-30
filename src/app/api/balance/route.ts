import { requireUser } from '@/lib/auth';
import { balanceView } from '@/lib/usdc';
import { failure } from '@/lib/http';
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(await balanceView(user.id), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return failure(error);
  }
}
