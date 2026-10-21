import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PracticeReviewCase } from '../src/components/practice-review-case';
import { reviewViewFixture as review } from './helpers/practice-review-view-fixture';
const render = (value = review) =>
  renderToStaticMarkup(createElement(PracticeReviewCase, { review: value }));
it('renders exact original evidence/rubric/declarations and distinguishes history from findings', () => {
  const html = render();
  for (const text of [
    'Original submission',
    'Original review criteria',
    'Original ownership declaration: Unconfirmed',
    'does not include later ownership findings',
    'Expected time',
    'not a deadline',
    review.definition.brief,
    review.definition.passConditions,
    review.submission.assistanceDisclosure,
  ])
    expect(html).toContain(text);
  expect(html).toContain('AI assistance declared: Yes');
  expect(html).toContain('Ownership review');
  expect(html).toContain(review.definition.reference.recordId);
  expect(html).toContain(review.definition.rubric.reference.recordId);
  for (const criterion of review.definition.rubric.criteria)
    expect(html).toContain(criterion.description);
  expect(html).not.toMatch(/<input|<button|<script|<img|<iframe|<form/);
});
it('escapes supplied code/prose and preserves whitespace without executing, fetching or linking it', () => {
  const html = render();
  expect(html).toContain('\n  &lt;script&gt;private-answer-marker&lt;/script&gt;\r\n');
  expect(html).toContain('private-explanation-marker &lt;img src=x&gt;');
  expect(html).toContain('white-space:pre-wrap');
  expect(html).toContain('overflow-wrap:anywhere');
  expect(html).not.toMatch(/<a |<script|<img /);
});
it('labels assessment purpose and undeclared AI/tools literally', () => {
  const html = render({
    ...review,
    assignment: { ...review.assignment, purpose: 'ASSESSMENT_REVIEW' },
    submission: { ...review.submission, toolsUsed: [], aiAssistanceUsed: false },
  });
  expect(html).toContain('Assessment review');
  expect(html).toContain('AI assistance declared: No');
  expect(html).toContain('No tools declared');
});
it('renders the same evidence without mutating it or inventing a rank/finding', () => {
  const before = structuredClone(review);
  render();
  expect(review).toEqual(before);
  expect(render()).not.toMatch(
    /rank earned|you passed|verified rank|ownership confirmed|review saved/i,
  );
});
