import { partyHandlers } from '@/lib/party-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ partyId: string }> }) {
  return partyHandlers.PROPOSE(
    request,
    context.params.then((p) => p.partyId),
  );
}
