import { workHandlers } from '@/lib/work-workspace-http';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ consentId: string }> }) {
  return workHandlers.WITHDRAW_CONSENT(
    request,
    context.params.then((p) => p.consentId),
  );
}
