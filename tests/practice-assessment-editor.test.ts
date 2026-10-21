import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  PracticeAssessmentEditor,
  SavedAssessmentResult,
} from '../src/components/practice-assessment-editor';
import { assessmentContextFixture as context } from './helpers/practice-assessment-view-fixture';
import { assessmentDecisionView } from './helpers/practice-assessment-http-fixture';
it('renders actual approved assessment policy, original criteria and escaped evidence with reasoned review inputs', () => {
  const html = renderToStaticMarkup(createElement(PracticeAssessmentEditor, { context }));
  for (const text of [
    'Approved assessment policy',
    'Record assessment review',
    'Confidence statement',
    'Original submission',
    'Original review criteria',
    'private-policy-marker',
    'Recheck current case',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain('<script>private-policy');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toMatch(/<fieldset[^>]*disabled=""/);
  expect(html).not.toContain('Record assessment state decision');
});
it.each([
  { ...context, policy: null },
  { ...context, reviewWritesAvailable: false, decisionWritesAvailable: false },
])('renders read-only without current approved policy and writes %#', (c) => {
  const html = renderToStaticMarkup(createElement(PracticeAssessmentEditor, { context: c }));
  expect(html).not.toContain('type="submit"');
  expect(html).toMatch(/No approved policy|New assessment actions are disabled/);
});
it('makes original ownership and actual verification distinct, and disables verification without confirmed ownership', () => {
  const html = renderToStaticMarkup(createElement(PracticeAssessmentEditor, { context }));
  expect(html).toContain('Original ownership declaration: Unconfirmed');
  expect(html).toMatch(/<option value="VERIFY" disabled=""/);
  expect(html).toContain('No current skill assessment is available for this case');
});
it('labels historical saved decision explicitly', () => {
  const html = renderToStaticMarkup(
    createElement(SavedAssessmentResult, {
      saved: {
        kind: 'decisions',
        view: {
          ...assessmentDecisionView,
          currentAssessmentReference: {
            ...assessmentDecisionView.currentAssessmentReference,
            revision: 3,
          },
          isCurrent: false,
        } as never,
      },
    }),
  );
  expect(html).toContain('Saved decision (historical)');
  expect(html).toContain('A newer assessment exists');
  expect(html).toContain('Recheck to refresh the source context and policy shown above.');
});
