import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillTaxonomyForm, type SkillTaxonomyTransport } from './components/skill-taxonomy-form';
import { SkillTaxonomyEditorStateSchema } from './skills/taxonomy-http-contracts';
const state = SkillTaxonomyEditorStateSchema.parse({
  version: 'v1',
  taxonomyId: 'synthetic-catalog',
  publisherAccountId: 'synthetic-admin',
  taxonomy: null,
  writesAvailable: true,
  unavailableReason: null,
});
let calls = 0;
const api: SkillTaxonomyTransport = {
  publish: async () => {
    calls++;
    throw Error('Synthetic SSR must not publish');
  },
  read: async () => {
    calls++;
    throw Error('Synthetic SSR must not read');
  },
};
const html = renderToStaticMarkup(createElement(SkillTaxonomyForm, { state, api }));
for (const s of [
  'No catalog has been published',
  'Add category',
  'Review changes',
  'Loading catalog controls',
  'disabled=""',
  'Turn on JavaScript',
])
  assert(html.includes(s));
assert(!html.includes('Frontend'));
const saved = renderToStaticMarkup(
  createElement(SkillTaxonomyForm, {
    state: {
      ...state,
      writesAvailable: false,
      unavailableReason: 'DISABLED',
      taxonomy: {
        version: 'v1',
        id: state.taxonomyId,
        revision: 1,
        state: 'PUBLISHED',
        publishedAt: '2026-10-14T00:00:00Z',
        publishedByAccountId: 'previous-admin',
        skills: [
          {
            id: 'frontend',
            domain: 'software.frontend',
            name: 'Saved frontend',
            status: 'RETIRED',
            aliases: ['frontend', 'web-ui'],
          },
        ],
      },
    },
    api,
  }),
);
for (const s of [
  'Saved frontend',
  'web-ui',
  'software.frontend',
  'Publication is currently unavailable',
  'readOnly=""',
  'disabled=""',
])
  assert(saved.includes(s), s);
assert.throws(
  () =>
    renderToStaticMarkup(
      createElement(SkillTaxonomyForm, {
        state: { ...state, publisherAccountId: 'invalid publisher' },
        api,
      }),
    ),
  /INVALID_HOST_CONTRACT/,
);
assert.equal(calls, 0);
console.log(
  JSON.stringify({
    synthetic: true,
    portableReact: true,
    noSeed: true,
    hydrationDisabled: true,
    actualSavedIdentity: true,
    disabledWrites: true,
    invalidHostDenied: true,
    noHiddenAuthorityOrDispatch: true,
  }),
);
