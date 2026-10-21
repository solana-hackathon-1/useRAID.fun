import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PracticeOwnershipEditor } from '../src/components/practice-ownership-editor';
import { ownershipContextFixture as context } from './helpers/practice-ownership-view-fixture';
it('renders actual approved guidance, current absence and original escaped evidence beside reasoned inputs', () => {
  const html = renderToStaticMarkup(createElement(PracticeOwnershipEditor, { context }));
  expect(html).toContain('Record ownership finding');
  expect(html).toContain('No ownership finding recorded');
  expect(html).toContain('private-policy-marker');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>private-policy');
  expect(html).toContain('Original submission');
  expect(html).toContain('Original review criteria');
  expect(html).toContain('Reason');
  expect(html).toContain('Observation 1');
  expect(html).not.toContain('This screen does not record review decisions');
  expect(html).toContain('does not verify a rank');
});
it('does not offer new finding without an approved policy', () => {
  const html = renderToStaticMarkup(
    createElement(PracticeOwnershipEditor, { context: { ...context, policy: null } }),
  );
  expect(html).toContain('No approved policy');
  expect(html).not.toContain('type="submit"');
});
it('shows existing context read-only when writes are disabled', () => {
  const html = renderToStaticMarkup(
    createElement(PracticeOwnershipEditor, { context: { ...context, writesAvailable: false } }),
  );
  expect(html).toContain('New findings are disabled');
  expect(html).not.toContain('type="submit"');
});
it('keeps the server-rendered form disabled until client handlers are ready', () => {
  const html = renderToStaticMarkup(createElement(PracticeOwnershipEditor, { context }));
  expect(html).toMatch(/<fieldset[^>]* disabled=""/);
});
it('labels an original replay as historical when a newer current finding exists', () => {
  const historical = {
    isCurrent: false,
    record: {
      ownership: 'CONFIRMED',
      reference: { recordId: context.review.submission.reference.recordId, revision: 1 },
      reason: 'Original saved reason.',
      observations: [{ kind: 'OTHER', detail: 'Original observation.' }],
      evaluatorAccountId: 'original-evaluator',
      policyReference: { recordId: 'old-policy', revision: 1 },
    },
  };
  const html = renderToStaticMarkup(
    createElement(PracticeOwnershipEditor, {
      context: { ...context, ownership: historical as never },
    }),
  );
  expect(html).toContain('Saved finding (historical)');
  expect(html).toContain('A newer finding exists');
});
