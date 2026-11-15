import { skillAppealHandlers } from '@/lib/skill-appeals-http';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ appealId: string }> }) {
  return skillAppealHandlers.ADJUDICATE(
    request,
    context.params.then((p) => p.appealId),
  );
}
