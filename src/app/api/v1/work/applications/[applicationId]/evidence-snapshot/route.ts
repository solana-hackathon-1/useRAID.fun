import { evidenceSnapshotHandlers } from '@/lib/work-evidence-snapshot-http';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ applicationId: string }> };
export function GET(request: Request, context: Context) {
  return evidenceSnapshotHandlers.VIEW(
    request,
    context.params.then((p) => p.applicationId),
  );
}
export function POST(request: Request, context: Context) {
  return evidenceSnapshotHandlers.RECORD(
    request,
    context.params.then((p) => p.applicationId),
  );
}
