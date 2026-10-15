import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillClaimForm, type SkillClaimTransport } from './components/skill-claim-form';
import { PublishedSkillTaxonomySchema } from './skills/contracts';
import { SkillClaimHttpStateSchema } from './skills/http-contracts';
const catalog = PublishedSkillTaxonomySchema.parse({
  version: 'v1',
  id: 'synthetic-catalog',
  revision: 1,
  state: 'PUBLISHED',
  publishedByAccountId: 'synthetic-admin',
  publishedAt: '2026-10-13T00:00:00Z',
  skills: [
    {
      id: 'frontend',
      domain: 'software.frontend',
      name: 'Frontend',
      status: 'ACTIVE',
      aliases: ['frontend'],
    },
  ],
});
const state = SkillClaimHttpStateSchema.parse({
  version: 'v1',
  skillId: 'frontend',
  claim: null,
  writesAvailable: true,
  unavailableReason: null,
});
let calls = 0;
const api: SkillClaimTransport = {
  save: async () => {
    calls++;
    throw Error('Synthetic SSR must not dispatch');
  },
  read: async () => {
    calls++;
    throw Error('Synthetic SSR must not read');
  },
  readCatalog: async () => {
    calls++;
    throw Error('Synthetic SSR must not read');
  },
};
const props = { state, catalog, participantId: 'synthetic-owner', api };
const html = renderToStaticMarkup(createElement(SkillClaimForm, props));
assert(html.includes('Self-reported claim; this claim does not verify a rank.'));
assert(html.includes('Self-reported experience'));
assert(html.includes('Private proof URLs'));
assert(html.includes('Save private claim'));
assert(html.includes('<fieldset class="orientation-fields" disabled=""'));
assert(html.includes('Loading private claim controls'));
assert(html.includes('Turn on JavaScript'));
const disabled = renderToStaticMarkup(
  createElement(SkillClaimForm, {
    ...props,
    state: { ...state, writesAvailable: false, unavailableReason: 'DISABLED' },
  }),
);
assert(disabled.includes('Saving new claims is currently unavailable'));
assert(disabled.includes('disabled=""'));
assert.equal(calls, 0);
assert.throws(() =>
  renderToStaticMarkup(
    createElement(SkillClaimForm, { ...props, participantId: 'invalid participant' }),
  ),
);
console.log(
  JSON.stringify({
    synthetic: true,
    portableReact: true,
    enabledAndDisabled: true,
    noHiddenAppOrNetwork: true,
    unverifiedLabels: true,
    invalidHostDenied: true,
  }),
);
