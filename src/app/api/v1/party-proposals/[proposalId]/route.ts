import { partyHandlers } from '@/lib/party-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request, context: { params: Promise<{ proposalId: string }> }) {
  return partyHandlers.READ(
    request,
    context.params.then((p) => p.proposalId),
  );
}
