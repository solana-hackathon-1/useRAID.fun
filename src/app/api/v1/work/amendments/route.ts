import { amendmentHandlers } from '@/lib/work-amendment-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return amendmentHandlers.DESK(request);
}
export function POST(request: Request) {
  return amendmentHandlers.PROPOSE(request);
}
