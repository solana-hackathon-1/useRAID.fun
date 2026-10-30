import { guildRolesHandlers } from '@/lib/guild-roles-http';

export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ grantId: string }> }) {
  return guildRolesHandlers.REVOKE(
    request,
    context.params.then((p) => p.grantId),
  );
}
