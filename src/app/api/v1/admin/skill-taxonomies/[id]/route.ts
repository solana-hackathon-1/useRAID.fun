import { skillTaxonomyHandlers, skillTaxonomyReadHandler } from '@/lib/skill-taxonomy-http';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return skillTaxonomyHandlers.POST(
    request,
    context.params.then((p) => p.id),
  );
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return skillTaxonomyReadHandler.GET(
    request,
    context.params.then((p) => p.id),
  );
}
