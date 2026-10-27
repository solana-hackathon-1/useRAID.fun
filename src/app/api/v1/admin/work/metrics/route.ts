import { metricsHandlers } from '@/lib/work-metrics-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return metricsHandlers.GET(request);
}
