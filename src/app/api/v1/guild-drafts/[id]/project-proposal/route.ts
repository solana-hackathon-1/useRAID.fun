import { projectProposalHandlers } from '@/lib/project-proposal-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return projectProposalHandlers.GET(
    request,
    context.params.then((p) => p.id),
  );
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return projectProposalHandlers.POST(
    request,
    context.params.then((p) => p.id),
  );
}
