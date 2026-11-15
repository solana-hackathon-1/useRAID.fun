import { evidenceSnapshotHandlers } from '@/lib/work-evidence-snapshot-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ applicationId: string }> }) {
  return evidenceSnapshotHandlers.WITHDRAW(
    request,
    context.params.then((p) => p.applicationId),
  );
}
