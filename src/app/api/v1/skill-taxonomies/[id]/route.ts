import { skillClaimHandlers } from '@/lib/skill-claims-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return skillClaimHandlers.CATALOG_GET(
    request,
    context.params.then((p) => p.id),
  );
}
