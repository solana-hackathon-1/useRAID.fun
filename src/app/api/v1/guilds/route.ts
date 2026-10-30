import { guildPublicHandlers } from '@/lib/guild-public-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return guildPublicHandlers.GUILDS(request);
}
