import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { PracticeAssignmentManager } from '../src/components/practice-assignment-manager';
import { createPracticeAssignmentManagementLoader } from '../src/skills/practice-assignment-management-page';
import {
  managementContext as context,
  managementSubmissionId as submissionId,
} from './helpers/practice-assignment-management-view-fixture';
it('dispatches current admin GET on server without self-network and validates exact binding', async () => {
  const get = vi.fn().mockResolvedValue(Response.json(context));
  expect(await createPracticeAssignmentManagementLoader(get)({ submissionId })).toEqual({
    status: 'READY',
    context,
  });
  expect(get).toHaveBeenCalledOnce();
  expect(get.mock.calls[0][0].url).toContain('submissionId=' + submissionId);
});
it('loads blank authenticated manager/config state', async () => {
  const blank = { ...context, page: { ...context.page, submissionId: null, entries: [] } };
  const get = vi.fn().mockResolvedValue(Response.json(blank));
  expect(await createPracticeAssignmentManagementLoader(get)({})).toEqual({
    status: 'READY',
    context: blank,
  });
});
it.each([
  { submissionId: ['a', 'b'] },
  { after: submissionId },
  { actor: 'foreign' },
  { submissionId: 'bad' },
])('rejects invalid/unknown search before any protected lookup %s', async (search) => {
  const get = vi.fn();
  expect(await createPracticeAssignmentManagementLoader(get)(search)).toEqual({
    status: 'NOT_FOUND',
  });
  expect(get).not.toHaveBeenCalled();
});
it.each([
  [401, 'SIGN_IN'],
  [403, 'DENIED'],
  [429, 'RATE_LIMITED'],
  [503, 'UNAVAILABLE'],
  [422, 'NOT_FOUND'],
] as const)('maps HTTP%s with no private error-body render', async (code, status) => {
  const get = vi.fn().mockResolvedValue(new Response('private secret', { status: code }));
  expect(await createPracticeAssignmentManagementLoader(get)({})).toEqual({ status });
});
it('fails closed for misbound/extra private success', async () => {
  const get = vi
    .fn()
    .mockResolvedValue(
      Response.json({ ...context, page: { ...context.page, answer: 'private secret' } }),
    );
  expect(await createPracticeAssignmentManagementLoader(get)({ submissionId })).toEqual({
    status: 'UNAVAILABLE',
  });
  get.mockResolvedValue(Response.json(context));
  expect(await createPracticeAssignmentManagementLoader(get)({})).toEqual({
    status: 'UNAVAILABLE',
  });
});
it('renders accessible lookup, immutable issue history/current observation and explicit reasoned issue/revoke forms', () => {
  const html = renderToStaticMarkup(createElement(PracticeAssignmentManager, { context }));
  for (const text of [
    'Find submission ID',
    'Lookup appointments',
    'Appointments observed',
    'ACTIVE',
    'Original synthetic assignment.',
    'New appointment',
    'Evaluator account ID',
    'Review purpose',
    'Expiry (UTC)',
    'Appointment reason',
    'Issue appointment',
    'Revoke appointment',
    'Revocation reason',
    'Refresh current appointments',
  ])
    expect(html).toContain(text);
  expect(html).toContain('type="datetime-local"');
  expect(html).toContain('disabled=""');
  expect(html).not.toMatch(/name="(actor|admin|verified)"/);
});
it('escapes untrusted metadata/reason text and performs no SSR command/network call', () => {
  const write = vi.fn(),
    read = vi.fn(),
    html = renderToStaticMarkup(
      createElement(PracticeAssignmentManager, {
        context: {
          ...context,
          page: {
            ...context.page,
            entries: [
              {
                ...context.page.entries[0],
                assignment: {
                  ...context.page.entries[0].assignment,
                  reason: '<script>inert-private-note</script>',
                },
              },
            ],
          },
        },
        transport: { write, read },
      }),
    );
  expect(html).toContain('&lt;script&gt;inert-private-note&lt;/script&gt;');
  expect(html).not.toContain('<script>');
  expect(write).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it('renders honest writeoff and empty lookup states without a guessed default duration', () => {
  const html = renderToStaticMarkup(
    createElement(PracticeAssignmentManager, {
      context: {
        ...context,
        writesAvailable: false,
        unavailableReason: 'DISABLED',
        page: { ...context.page, entries: [] },
      },
    }),
  );
  expect(html).toContain('New appointment changes are disabled');
  expect(html).toContain('No appointments on this page');
  expect(html).toContain('type="datetime-local"');
  expect(html).not.toContain('value="2030');
});
