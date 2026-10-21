import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { reviewScope, reviewViewFixture as review } from './helpers/practice-review-view-fixture';
const port = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('../src/lib/practice-review-http', () => ({ practiceReviewHandlers: { GET: port.GET } }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
import Page, {
  metadata,
  dynamic,
} from '../src/app/evaluator/practice/[assignmentId]/submissions/[submissionId]/page';
import Loading from '../src/app/evaluator/practice/[assignmentId]/submissions/[submissionId]/loading';
const props = () => ({
  params: Promise.resolve({
    assignmentId: reviewScope.assignmentId,
    submissionId: reviewScope.submissionId,
  }),
  searchParams: Promise.resolve({ purpose: reviewScope.purpose }),
});
beforeEach(() => port.GET.mockReset());
it('renders only after current protected GET and rechecks through a native same-case GET form', async () => {
  port.GET.mockResolvedValue(
    Response.json({ version: 'v1', readsAvailable: true, unavailableReason: null, review }),
  );
  const html = renderToStaticMarkup(await Page(props()));
  expect(port.GET).toHaveBeenCalledTimes(1);
  expect(html).toContain('private-answer-marker');
  expect(html).toContain('Recheck access');
  expect(html).toContain('method="get"');
  expect(html).toContain('name="purpose" value="OWNERSHIP_REVIEW"');
  expect(html).not.toMatch(/name="(actor|evaluator|verified)"/);
});
it.each([
  [401, 'Sign in to view this assigned case'],
  [403, 'unavailable for your account'],
  [429, 'Too many requests'],
  [503, 'currently unavailable'],
] as const)('does not render a private body after HTTP%s', async (status, message) => {
  port.GET.mockResolvedValue(new Response('private-answer-marker', { status }));
  const html = renderToStaticMarkup(await Page(props()));
  expect(html).toContain(message);
  expect(html).not.toContain('private-answer-marker');
  expect(html).not.toContain('Original submission');
});
it('uses non-enumerable not-found for missing/denied case or malformed scope', async () => {
  port.GET.mockResolvedValue(new Response(null, { status: 404 }));
  await expect(Page(props())).rejects.toThrow('NOT_FOUND');
  await expect(
    Page({ ...props(), searchParams: Promise.resolve({ purpose: 'bad' as never }) }),
  ).rejects.toThrow('NOT_FOUND');
});
it('keeps metadata/loading generic and disables indexing; no client case prefetch', () => {
  expect(dynamic).toBe('force-dynamic');
  expect(metadata).toMatchObject({
    title: 'Practice review',
    robots: { index: false, follow: false },
  });
  expect(JSON.stringify(metadata)).not.toContain('private-answer-marker');
  expect(renderToStaticMarkup(createElement(Loading))).toContain('Loading practice review');
});
