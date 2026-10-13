import Link from 'next/link';
import { cookies } from 'next/headers';
import { currentUser, hash } from '@/lib/auth';
import { sessionCookie } from '@/lib/studio-mode';
import { readGuildDraftState, guildDraftWriteConfiguration } from '@/lib/guild-draft-host';
import {
  GuildDraftHttpStateSchema,
  type GuildDraftFormState,
} from '@/guild-profiles/http-contracts';
import { GuildDraftForm } from './guild-draft-form';
export async function GuildDraftPage({ id }: { id?: string }) {
  const user = await currentUser(),
    cookie = (await cookies()).get(sessionCookie())?.value;
  if (!user || !cookie)
    return (
      <div className="studio">
        <h1>Private Guild draft</h1>
        <p>Sign in to manage your private draft.</p>
        <Link className="button" href="/creator/account">
          Sign in
        </Link>
      </div>
    );
  let state: GuildDraftFormState = {
    version: 'v1',
    draft: null,
    ...guildDraftWriteConfiguration(),
  };
  if (id) {
    try {
      const parsed = GuildDraftHttpStateSchema.safeParse(
        await readGuildDraftState(
          { accountId: user.id, actorAccountId: user.id, sessionHash: hash(cookie) },
          id,
        ),
      );
      if (!parsed.success || parsed.data.draft.id.toLowerCase() !== id.toLowerCase())
        throw Error('Invalid private state');
      state = parsed.data;
    } catch {
      return (
        <div className="studio">
          <h1>Private Guild draft</h1>
          <p role="alert">The private draft could not be loaded. Sign in or check the draft URL.</p>
          <Link className="inline-link" href="/creator/account">
            Account
          </Link>
        </div>
      );
    }
  }
  return (
    <div className="studio">
      <Link className="studio-back" href="/creator/account">
        ← Account
      </Link>
      <p>
        <Link className="inline-link" href="/creator/guild-drafts">
          My private drafts
        </Link>
      </p>
      <header className="studio-heading">
        <div>
          <h1>Private Guild draft</h1>
          <p>Prepare your project name and description.</p>
        </div>
      </header>
      {state.draft && (
        <p>
          <Link
            className="inline-link"
            href={'/creator/guild-drafts/' + state.draft.id + '/project'}
          >
            Prepare existing-project proposal
          </Link>
        </p>
      )}
      <GuildDraftForm state={state} />
    </div>
  );
}
