import { workHandlers } from '@/lib/work-workspace-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return workHandlers.ME(request);
}
