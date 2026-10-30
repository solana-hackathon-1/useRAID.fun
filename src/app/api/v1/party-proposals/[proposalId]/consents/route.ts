import { partyHandlers } from '@/lib/party-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ proposalId: string }> }) {
  return partyHandlers.CONSENT(
    request,
    context.params.then((p) => p.proposalId),
  );
}
