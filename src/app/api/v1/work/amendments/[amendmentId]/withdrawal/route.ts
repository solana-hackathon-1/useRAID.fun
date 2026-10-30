import { amendmentHandlers } from '@/lib/work-amendment-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ amendmentId: string }> }) {
  return amendmentHandlers.WITHDRAW(
    request,
    context.params.then((p) => p.amendmentId),
  );
}
