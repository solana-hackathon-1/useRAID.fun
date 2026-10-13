import { guildDraftHandlers } from '@/lib/guild-draft-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return guildDraftHandlers.GET(
    request,
    context.params.then((p) => p.id),
  );
}
