import { guildPublicHandlers } from '@/lib/guild-public-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  return guildPublicHandlers.GUILD(request, (await context.params).slug);
}
