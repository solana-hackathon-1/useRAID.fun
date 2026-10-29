import { guildUpdatesHandlers } from '@/lib/guild-updates-http';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ updateId: string }> }) {
  return guildUpdatesHandlers.STEP(
    request,
    context.params.then((p) => p.updateId),
  );
}
