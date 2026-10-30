import { guildRolesHandlers } from '@/lib/guild-roles-http';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ transferId: string }> }) {
  return guildRolesHandlers.RESPOND(
    request,
    context.params.then((p) => p.transferId),
  );
}
