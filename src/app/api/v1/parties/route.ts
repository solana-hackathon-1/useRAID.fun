import { partyHandlers } from '@/lib/party-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return partyHandlers.CREATE(request);
}
