import { workHandlers } from '@/lib/work-workspace-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return workHandlers.APPLY(request);
}
