import Link from 'next/link';
import { cookies } from 'next/headers';
import { currentUser, hash } from '@/lib/auth';
import { sessionCookie } from '@/lib/studio-mode';
import { readGuildDraftIndexState } from '@/lib/guild-draft-host';
import { SavedGuildDraftPageSchema } from '@/guild-profiles/draft-storage-contracts';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'My private Guild drafts' };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const user = await currentUser(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  if (!user || !cookie)
    return (
      <div className="studio">
        <h1>My private Guild drafts</h1>
        <p>Sign in to find your saved private drafts.</p>
        <Link className="button" href="/creator/account">
          Sign in
        </Link>
      </div>
    );
  let state: Awaited<ReturnType<typeof readGuildDraftIndexState>>;
  try {
    const { cursor } = await searchParams;
    state = await readGuildDraftIndexState(
      { accountId: user.id, actorAccountId: user.id, sessionHash: hash(cookie) },
      { cursor: cursor ?? null, pageSize: 20 },
    );
    if (!SavedGuildDraftPageSchema.safeParse(state.page).success)
      throw Error('Invalid private page');
  } catch {
    return (
      <div className="studio">
        <h1>My private Guild drafts</h1>
        <p role="alert">Private drafts could not be loaded. Refresh or sign in again.</p>
        <Link className="inline-link" href="/creator/guild-drafts">
          Start again
        </Link>
      </div>
    );
  }
  return (
    <div className="studio">
      <Link className="studio-back" href="/creator/account">
        ← Account
      </Link>
      <header className="studio-heading">
        <div>
          <h1>My private Guild drafts</h1>
          <p>Your saved project details stay in your account.</p>
        </div>
        <Link className="button" href="/creator/guild-drafts/new">
          Create a private draft
        </Link>
      </header>
      <div className="orientation-layout">
        {!state.writesAvailable && (
          <p role="status">
            Saving drafts is currently unavailable. Your saved drafts remain readable.
          </p>
        )}
        {state.page.drafts.length === 0 ? (
          <p>No private drafts saved yet.</p>
        ) : (
          state.page.drafts.map((draft) => (
            <section className="orientation-card" key={draft.id}>
              <h2>
                <Link className="inline-link" href={'/creator/guild-drafts/' + draft.id}>
                  {draft.profile.name}
                </Link>
              </h2>
              <p>{draft.profile.description}</p>
              <p>Saved revision {draft.revision}</p>
            </section>
          ))
        )}
        {state.page.nextCursor && (
          <Link
            className="button secondary"
            href={'/creator/guild-drafts?cursor=' + encodeURIComponent(state.page.nextCursor)}
          >
            More private drafts
          </Link>
        )}
      </div>
    </div>
  );
}
