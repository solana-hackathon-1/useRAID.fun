import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createPracticeReviewInboxLoader } from '../src/skills/practice-review-inbox-page';
import { PracticeReviewInbox } from '../src/components/practice-review-inbox';
const entry = (purpose = 'OWNERSHIP_REVIEW') => ({
  assignmentId: randomUUID(),
  submissionId: randomUUID(),
  purpose,
  issuedAt: '2026-10-21T11:00:00.000Z',
  expiresAt: '2026-10-21T13:00:00.000Z',
});
const page = () => ({
  version: 'v1' as const,
  private: true as const,
  isAuthorizationToken: false as const,
  accessId: randomUUID(),
  observedAt: '2026-10-21T12:00:00.000Z',
  entries: [entry(), entry('ASSESSMENT_REVIEW')].sort((a, b) =>
    a.assignmentId.localeCompare(b.assignmentId),
  ),
  nextCursor: null,
});
it('loads a fresh protected metadata response without an actual network request', async () => {
  const p = page(),
    get = vi.fn().mockResolvedValue(Response.json(p));
  const state = await createPracticeReviewInboxLoader(get)({});
  expect(state).toEqual({ status: 'READY', page: p });
  expect(get).toHaveBeenCalledOnce();
  expect(get.mock.calls[0][0].method).toBe('GET');
});
it.each([{ after: ['a', 'b'] }, { actor: 'foreign' }, { after: 'invalid' }])(
  'rejects unknown/duplicate/malformed query before dispatch %s',
  async (search) => {
    const get = vi.fn();
    expect(await createPracticeReviewInboxLoader(get)(search)).toEqual({ status: 'NOT_FOUND' });
    expect(get).not.toHaveBeenCalled();
  },
);
it.each([
  [401, 'SIGN_IN'],
  [403, 'DENIED'],
  [429, 'RATE_LIMITED'],
  [503, 'UNAVAILABLE'],
  [422, 'NOT_FOUND'],
] as const)('maps HTTP%s without consuming stale/error private bytes', async (code, status) => {
  const get = vi.fn().mockResolvedValue(new Response('private-answer-marker', { status: code }));
  expect(await createPracticeReviewInboxLoader(get)({})).toEqual({ status });
});
it.each(['extra', 'cursor', 'malformed'])('fails closed on incoherent success %s', async (kind) => {
  const p = page();
  if (kind === 'extra') Object.assign(p.entries[0], { reason: 'private-answer-marker' });
  if (kind === 'cursor') p.nextCursor = randomUUID() as never;
  const get = vi
    .fn()
    .mockResolvedValue(
      kind === 'malformed' ? new Response('<html>secret</html>') : Response.json(p),
    );
  expect(await createPracticeReviewInboxLoader(get)({})).toEqual({ status: 'UNAVAILABLE' });
});
it('renders purpose-specific links without case prefetch, explicit UTC expiry and no authority claim', () => {
  const p = page();
  const html = renderToStaticMarkup(
    createElement(PracticeReviewInbox, { state: { status: 'READY', page: p as never } }),
  );
  expect(html).toContain('Your practice reviews');
  expect(html).toContain('Ownership review');
  expect(html).toContain('Skill assessment');
  expect(html).toContain('UTC');
  for (const row of p.entries) {
    const path = '/evaluator/practice/' + row.assignmentId + '/submissions/' + row.submissionId;
    expect(html).toContain('href="' + path + '?purpose=' + row.purpose + '"');
    expect(html).toContain(
      'href="' + path + (row.purpose === 'OWNERSHIP_REVIEW' ? '/ownership' : '/assessment') + '"',
    );
  }
  expect(html).toContain('Access is checked again');
  expect(html).not.toMatch(/data-prefetch|next\/link|answer|issuedByAccountId/);
  expect(html).toContain('method="get"');
  expect(html).toContain('Refresh assignments');
});
it('renders empty observation and native next page with bounded current cursor', () => {
  const p = page();
  const empty = renderToStaticMarkup(
    createElement(PracticeReviewInbox, { state: { status: 'READY', page: { ...p, entries: [] } } }),
  );
  expect(empty).toContain('No current assignments');
  const html = renderToStaticMarkup(
    createElement(PracticeReviewInbox, {
      state: { status: 'READY', page: { ...p, nextCursor: p.entries[0].assignmentId } as never },
    }),
  );
  expect(html).toContain('href="/evaluator/practice?after=' + p.entries[0].assignmentId + '"');
  expect(html).toContain('More assignments');
});
it.each([
  ['SIGN_IN', 'Sign in'],
  ['DENIED', 'unavailable for your account'],
  ['RATE_LIMITED', 'Too many requests'],
  ['UNAVAILABLE', 'currently unavailable'],
] as const)('renders useful%s state with no private evidence', (status, message) => {
  const html = renderToStaticMarkup(createElement(PracticeReviewInbox, { state: { status } }));
  expect(html).toContain(message);
  expect(html).not.toContain('/submissions/');
});
