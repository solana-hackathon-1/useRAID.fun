import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  SkillTaxonomyForm,
  type SkillTaxonomyEditorInput,
} from '../src/components/skill-taxonomy-form';
const empty: SkillTaxonomyEditorInput = {
  version: 'v1',
  taxonomyId: 'actual-catalog',
  publisherAccountId: 'actual-admin',
  taxonomy: null,
  writesAvailable: true,
  unavailableReason: null,
};
it('renders an explicit empty catalog and hydration-disabled review/publication controls without seeding', () => {
  const html = renderToStaticMarkup(createElement(SkillTaxonomyForm, { state: empty }));
  expect(html).toContain('No catalog has been published');
  expect(html).toContain('Add category');
  expect(html).toContain('Review changes');
  expect(html).toContain('disabled=""');
  expect(html).toContain('Loading catalog controls');
  expect(html).not.toContain('Frontend');
});
it('renders actual saved identity/status/aliases and disabled new publication truthfully', () => {
  const state: SkillTaxonomyEditorInput = {
    ...empty,
    writesAvailable: false,
    unavailableReason: 'DISABLED',
    taxonomy: {
      version: 'v1',
      id: 'actual-catalog',
      revision: 2,
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
  };
  const html = renderToStaticMarkup(createElement(SkillTaxonomyForm, { state }));
  for (const value of [
    'Saved frontend',
    'software.frontend',
    'web-ui',
    'RETIRED',
    'revision 2',
    'Publication is currently unavailable',
  ])
    expect(html).toContain(value);
});
it('rejects malformed host/catalog bindings before rendering', () => {
  expect(() =>
    renderToStaticMarkup(
      createElement(SkillTaxonomyForm, {
        state: { ...empty, publisherAccountId: 'invalid publisher' },
      }),
    ),
  ).toThrow('INVALID_HOST_CONTRACT');
});
