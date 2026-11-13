import { metricsExclusionHandlers } from '@/lib/metrics-exclusion-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return metricsExclusionHandlers.POST(request);
}
