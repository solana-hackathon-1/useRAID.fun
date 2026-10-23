import { expect, it, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const port = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('../src/lib/practice-assignment-management', () => ({
  practiceAssignmentManagementHandlers: port,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
import Page, {
  metadata,
  dynamic,
  runtime,
} from '../src/app/admin/practice/review-assignments/page';
import Loading from '../src/app/admin/practice/review-assignments/loading';
import { managementContext as context } from './helpers/practice-assignment-management-view-fixture';
beforeEach(() => port.GET.mockReset());
it('renders only after actual protected GET and carries generic nonindex metadata/loading', async () => {
  port.GET.mockResolvedValue(Response.json(context));
  const html = renderToStaticMarkup(
    await Page({ searchParams: Promise.resolve({ submissionId: context.page.submissionId }) }),
  );
  expect(html).toContain('Original synthetic assignment.');
  expect(html).toContain('Issue appointment');
  expect(port.GET).toHaveBeenCalledOnce();
  expect(metadata).toMatchObject({
    title: 'Review appointments',
    robots: { index: false, follow: false },
  });
  expect(dynamic).toBe('force-dynamic');
  expect(runtime).toBe('nodejs');
  expect(renderToStaticMarkup(createElement(Loading))).toContain('Loading review appointments');
});
it.each([
  [401, 'Sign in with an authorized X administrator'],
  [403, 'unavailable for your account'],
  [429, 'Too many requests'],
  [503, 'currently unavailable'],
] as const)('does not render stale private notes after HTTP%s', async (code, message) => {
  port.GET.mockResolvedValue(new Response('private secret', { status: code }));
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
  expect(html).toContain(message);
  expect(html).not.toContain('private secret');
  expect(html).not.toContain('Original synthetic assignment.');
});
it('rejects malformed path selection before private GET', async () => {
  await expect(
    Page({ searchParams: Promise.resolve({ submissionId: ['a', 'b'] }) }),
  ).rejects.toThrow('NOT_FOUND');
  expect(port.GET).not.toHaveBeenCalled();
});
