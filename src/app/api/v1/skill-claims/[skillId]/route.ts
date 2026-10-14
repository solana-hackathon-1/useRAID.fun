import { skillClaimHandlers } from '@/lib/skill-claims-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ skillId: string }> }) {
  return skillClaimHandlers.GET(
    request,
    context.params.then((p) => p.skillId),
  );
}
export async function POST(request: Request, context: { params: Promise<{ skillId: string }> }) {
  return skillClaimHandlers.POST(
    request,
    context.params.then((p) => p.skillId),
  );
}
