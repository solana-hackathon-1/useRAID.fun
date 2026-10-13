import Link from 'next/link';
import { cookies } from 'next/headers';
import { currentUser, hash } from '@/lib/auth';
import { sessionCookie } from '@/lib/studio-mode';
import { readProjectProposalPageState } from '@/lib/project-proposal-host';
import { GuildProjectProposalHttpStateSchema } from '@/guild-profiles/project-proposal-http-contracts';
import { SavedGuildDraftSchema } from '@/guild-profiles/draft-storage-contracts';
import { ProjectProposalForm } from '@/components/project-proposal-form';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Private existing-project proposal' };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    user = await currentUser(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  if (!user || !cookie)
    return (
      <div className="studio">
        <h1>Private existing-project proposal</h1>
        <p>Sign in to manage your private proposal.</p>
        <Link className="button" href="/creator/account">
          Sign in
        </Link>
      </div>
    );
  let loaded: {
    draft: ReturnType<typeof SavedGuildDraftSchema.parse>;
    state: ReturnType<typeof GuildProjectProposalHttpStateSchema.parse>;
  };
  try {
    const value = await readProjectProposalPageState(
        { accountId: user.id, actorAccountId: user.id, sessionHash: hash(cookie) },
        id,
      ),
      draft = SavedGuildDraftSchema.parse(value.draft),
      state = GuildProjectProposalHttpStateSchema.parse(value.state);
    if (
      draft.id.toLowerCase() !== id.toLowerCase() ||
      state.guildDraftId !== draft.id.toLowerCase()
    )
      throw Error('Wrong private resource');
    loaded = { draft, state };
  } catch {
    return (
      <div className="studio">
        <h1>Private existing-project proposal</h1>
        <p role="alert">
          The private proposal could not be loaded. Sign in or check the draft URL.
        </p>
        <Link className="inline-link" href="/creator/account">
          Account
        </Link>
      </div>
    );
  }
  const { draft, state } = loaded;
  return (
    <div className="studio">
      <Link className="studio-back" href={'/creator/guild-drafts/' + draft.id}>
        ← Private draft
      </Link>
      <header className="studio-heading">
        <div>
          <h1>Private existing-project proposal</h1>
          <p>Prepare a token relationship and supporting references for later verification.</p>
        </div>
      </header>
      <ProjectProposalForm state={state} draftRevision={draft.revision} />
    </div>
  );
}
