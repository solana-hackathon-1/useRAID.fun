import { ownSkillAssessmentHandlers } from '@/lib/own-skill-assessments-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ skillId: string }> }) {
  return ownSkillAssessmentHandlers.GET(
    request,
    context.params.then((p) => p.skillId),
  );
}
