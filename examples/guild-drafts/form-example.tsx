import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuildDraftForm, type GuildDraftTransport } from './components/guild-draft-form';
import type { GuildDraftFormState } from './guild-profiles/http-contracts';
let requests = 0;
const api: GuildDraftTransport = {
  save: async () => {
    requests++;
    throw Error('SSR must not submit');
  },
  read: async () => {
    requests++;
    throw Error('SSR must not read');
  },
};
const state: GuildDraftFormState = {
  version: 'v1',
  draft: null,
  writesAvailable: true,
  unavailableReason: null,
};
const html = renderToStaticMarkup(
  <GuildDraftForm state={state} api={api} draftLinkPrefix="/alternate/drafts/" />,
);
for (const text of [
  'Guild name',
  'Draft URL',
  'Description',
  'Save private draft',
  'This draft stays private.',
  'Founder control has not been verified.',
])
  assert(html.includes(text));
const disabled = renderToStaticMarkup(
  <GuildDraftForm
    state={{ ...state, writesAvailable: false, unavailableReason: 'DISABLED' }}
    api={api}
  />,
);
assert(disabled.includes('Saving drafts is currently unavailable.'));
assert(disabled.includes('disabled'));
assert.equal(requests, 0);
console.log(
  JSON.stringify({
    synthetic: true,
    ownReactHost: true,
    noNextDependency: true,
    semanticPrivateForm: true,
    explicitUnavailable: true,
    noHiddenRequest: true,
  }),
);
