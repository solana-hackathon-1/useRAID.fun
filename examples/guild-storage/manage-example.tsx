import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuildProfileEditor, GuildUpdatesManager } from './components/guild-manage';
import type { GuildManageApi } from './guild-profiles/guild-manage-client';
import type { ManagedGuild } from './guild-profiles/guild-storage-contracts';

// The host owns the transport: this one fails loudly, so server rendering is proven not to submit or read anything.
let requests = 0;
const refuse = async (): Promise<Response> => {
  requests++;
  throw Error('SSR must not call the transport');
};
const api: GuildManageApi = {
  readProfile: refuse,
  editProfile: refuse,
  draftUpdate: refuse,
  stepUpdate: refuse,
};
const guild: ManagedGuild = {
  version: 'v1',
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'synthetic-guild',
  name: 'Synthetic <b>Guild</b>',
  description: 'Fish & chips',
  founderAccountId: null,
  revision: 3,
  state: 'ACTIVE',
  primaryToken: null,
};
const profile = renderToStaticMarkup(
  <GuildProfileEditor guild={guild} writesAvailable api={api} />,
);
for (const text of ['Guild name', 'Description', 'Save profile', 'Saved revision 3'])
  assert(profile.includes(text), text);
assert(profile.includes('Synthetic &lt;b&gt;Guild&lt;/b&gt;'), 'plain text is escaped');
const off = renderToStaticMarkup(
  <GuildProfileEditor guild={guild} writesAvailable={false} api={api} />,
);
assert(off.includes('Editing the profile is currently unavailable'));
const updates = renderToStaticMarkup(
  <GuildUpdatesManager
    guildId={guild.id}
    updates={[]}
    founder={false}
    writesAvailable={false}
    api={api}
  />,
);
for (const text of [
  'No updates yet.',
  'Only the Founder can publish',
  'New drafts and publishing are currently unavailable',
])
  assert(updates.includes(text), text);
assert.equal(requests, 0);
console.log(
  'PASS: independent React host rendered the Guild profile editor and updates manager; SIMULATED ONLY.',
);
