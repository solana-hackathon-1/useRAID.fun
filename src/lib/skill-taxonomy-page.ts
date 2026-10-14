import { cookies } from 'next/headers';
import { currentSession, hash } from './auth';
import { adminXIds } from './admins';
import { sessionCookie } from './studio-mode';
import { skillClaimCatalogConfiguration } from './skill-claims-host';
import { readSkillTaxonomyEditorState } from './skill-taxonomy-host';
export async function loadSkillTaxonomyEditor() {
  const session = await currentSession();
  if (!session) return { status: 'SIGN_IN' as const };
  const user = session.user;
  if (session.via !== 'x' || user.role !== 'ADMIN' || !user.xId || !adminXIds().includes(user.xId))
    return { status: 'FORBIDDEN' as const };
  const id = skillClaimCatalogConfiguration(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  if (!id || !cookie) return { status: 'UNAVAILABLE' as const };
  try {
    const state = await readSkillTaxonomyEditorState(
      { accountId: user.id, sessionHash: hash(cookie) },
      id,
    );
    return { status: 'READY' as const, state };
  } catch {
    return { status: 'UNAVAILABLE' as const };
  }
}
