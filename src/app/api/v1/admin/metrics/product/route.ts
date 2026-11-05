import { productMetricsHandlers } from '@/lib/product-metrics-http';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return productMetricsHandlers.GET(request);
}
