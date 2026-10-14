import { cookies } from 'next/headers';
import { currentUser, hash } from './auth';
import { sessionCookie } from './studio-mode';
import { skillClaimCatalogConfiguration, readSkillCatalogState } from './skill-claims-host';
export async function loadPrivateSkillCatalog() {
  const user = await currentUser(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  if (!user || !cookie) return { status: 'SIGN_IN' as const };
  const id = skillClaimCatalogConfiguration();
  if (!id) return { status: 'UNAVAILABLE' as const };
  const actor = { accountId: user.id, sessionHash: hash(cookie) };
  try {
    const { taxonomy } = await readSkillCatalogState(actor, id);
    if (!taxonomy) return { status: 'UNAVAILABLE' as const };
    return { status: 'READY' as const, actor, taxonomy };
  } catch {
    return { status: 'UNAVAILABLE' as const };
  }
}
