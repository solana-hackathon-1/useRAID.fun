import { expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
const port = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('../src/lib/practice-review-inbox', () => ({ practiceReviewInboxHandlers: port }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
import Page, { metadata, dynamic, runtime } from '../src/app/evaluator/practice/page';
import Loading from '../src/app/evaluator/practice/loading';
beforeEach(() => port.GET.mockReset());
it('renders current protected inbox and generic metadata/loading', async () => {
  port.GET.mockResolvedValue(
    Response.json({
      version: 'v1',
      private: true,
      isAuthorizationToken: false,
      accessId: '00000000-0000-4000-8000-000000000001',
      observedAt: '2026-10-21T12:00:00.000Z',
      entries: [],
      nextCursor: null,
    }),
  );
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('No current assignments');
  expect(port.GET).toHaveBeenCalledOnce();
  expect(metadata).toMatchObject({
    title: 'Practice assignments',
    robots: { index: false, follow: false },
  });
  expect(dynamic).toBe('force-dynamic');
  expect(runtime).toBe('nodejs');
  expect(renderToStaticMarkup(createElement(Loading))).toContain('Loading practice assignments');
});
it('fails closed on unknown search params without a protected read', async () => {
  await expect(Page({ searchParams: Promise.resolve({ actor: 'foreign' }) })).rejects.toThrow(
    'NOT_FOUND',
  );
  expect(port.GET).not.toHaveBeenCalled();
});
