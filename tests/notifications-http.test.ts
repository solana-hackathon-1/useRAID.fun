import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WorkError } from '../src/work-loop/contracts';
import { WorkHttpError } from '../src/work-http/workspace-http';
import {
  createNotificationHandlers,
  NotificationStateSchema,
  type NotificationsHttpHost,
} from '../src/notifications/http';
import { createNotificationClient } from '../src/notifications/client';
import { NotificationsPanel } from '../src/components/notifications-panel';
import {
  categoryAllowed,
  describeNotification,
  NOTIFICATION_KINDS,
} from '../src/notifications/contracts';
import type { WorkTransport } from '../src/work-http/workspace-client';

const actor = { accountId: 'account-1', sessionHash: 'a'.repeat(64) };
const id = '11111111-1111-4111-8111-111111111111';
const state = {
  version: 'v1' as const,
  items: [
    {
      id,
      kind: 'REVIEW_DECIDED' as const,
      message: 'Your submission has a review decision.',
      link: '/raider/work' as const,
      createdAt: '2026-10-26T10:00:00.000Z',
      read: false,
    },
  ],
  unread: 1,
  preferences: { promotional: false },
};
function host(overrides: Partial<NotificationsHttpHost> = {}): NotificationsHttpHost {
  return {
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => actor,
    checkOrigin: () => {},
    rateLimit: () => {},
    state: async () => state,
    markRead: async (_a, target) => ({ id: target, read: true }),
    setPreferences: async (_a, value) => value,
    ...overrides,
  };
}
const post = (path: string, payload: unknown) =>
  new Request('http://localhost' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
describe('T042 notification text', () => {
  it('has fixed, short, link-safe text for every kind and never makes work notices a preference', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const text = describeNotification(kind);
      expect(text.message.length).toBeGreaterThan(10);
      expect(text.message.length).toBeLessThan(120);
      expect(text.link).toMatch(/^\/(raider|creator)\/work$/);
      expect(text.message).not.toMatch(/https?:|token|@/i);
    }
    expect(categoryAllowed('TRANSACTIONAL', { promotional: false })).toBe(true);
    expect(categoryAllowed('PROMOTIONAL', { promotional: false })).toBe(false);
  });
});
describe('T042 notification HTTP boundary', () => {
  it('returns private no-store schema-checked state and fails closed on a contract break', async () => {
    const ok = await createNotificationHandlers(host()).STATE(
      new Request('http://localhost/api/v1/notifications'),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    const broken = createNotificationHandlers(
      host({
        state: async () => ({ ...state, items: [{ ...state.items[0], body: 'private text' }] }),
      }),
    );
    expect((await broken.STATE(new Request('http://localhost/api/v1/notifications'))).status).toBe(
      503,
    );
    expect(
      NotificationStateSchema.safeParse({
        ...state,
        items: [{ ...state.items[0], link: 'https://evil.example/?token=1' }],
      }).success,
    ).toBe(false);
  });
  it('requires origin, authentication and a rate-limit pass before writes; rejects queries and foreign methods', async () => {
    const markRead = vi.fn();
    for (const [status, mutate] of [
      [403, { checkOrigin: () => Promise.reject(new WorkHttpError(403)) }],
      [401, { actor: () => Promise.reject(new WorkHttpError(401)) }],
      [429, { rateLimit: () => Promise.reject(new WorkHttpError(429)) }],
    ] as const) {
      const r = await createNotificationHandlers(host({ markRead, ...mutate })).READ(
        post('/n', {}),
        id,
      );
      expect(r.status).toBe(status);
    }
    expect(markRead).not.toHaveBeenCalled();
    const handlers = createNotificationHandlers(host());
    expect(
      (await handlers.STATE(new Request('http://localhost/api/v1/notifications?x=1'))).status,
    ).toBe(422);
    expect(
      (
        await handlers.STATE(
          new Request('http://localhost/api/v1/notifications', { method: 'POST' }),
        )
      ).status,
    ).toBe(405);
  });
  it('marks one own notification read, hides foreign ids behind NOT_FOUND and checks the answer matches', async () => {
    const handlers = createNotificationHandlers(host());
    expect((await handlers.READ(post('/n', {}), id)).status).toBe(200);
    expect((await handlers.READ(post('/n', { extra: 1 }), id)).status).toBe(422);
    expect((await handlers.READ(post('/n', {}), 'not-a-uuid')).status).toBe(422);
    const foreign = createNotificationHandlers(
      host({
        markRead: async () => {
          throw new WorkError('NOT_FOUND');
        },
      }),
    );
    const r = await foreign.READ(post('/n', {}), id);
    expect(r.status).toBe(404);
    const swapped = createNotificationHandlers(
      host({ markRead: async () => ({ id: '22222222-2222-4222-8222-222222222222', read: true }) }),
    );
    expect((await swapped.READ(post('/n', {}), id)).status).toBe(503);
  });
  it('sets only the promotional preference, strictly', async () => {
    const handlers = createNotificationHandlers(host());
    expect((await handlers.PREFERENCES(post('/p', { promotional: true }))).status).toBe(200);
    expect((await handlers.PREFERENCES(post('/p', { promotional: 'yes' }))).status).toBe(422);
    expect(
      (await handlers.PREFERENCES(post('/p', { promotional: true, transactional: false }))).status,
    ).toBe(422);
    const lying = createNotificationHandlers(
      host({ setPreferences: async () => ({ promotional: false }) }),
    );
    expect((await lying.PREFERENCES(post('/p', { promotional: true }))).status).toBe(503);
  });
});
describe('T042 notification client and panel', () => {
  const transport = (status: number, body: unknown, seen: unknown[] = []): WorkTransport => ({
    async request(method, path, init) {
      seen.push([method, path, init]);
      return { status, body };
    },
  });
  it('parses strictly and surfaces safe error codes only', async () => {
    const seen: unknown[] = [];
    expect((await createNotificationClient(transport(200, state, seen)).state()).unread).toBe(1);
    await createNotificationClient(transport(200, { id, read: true }, seen)).markRead(id);
    expect(seen[1]).toEqual(['POST', `/api/v1/notifications/${id}/read`, { body: {} }]);
    await expect(
      createNotificationClient(transport(200, { ...state, surprise: 1 })).state(),
    ).rejects.toMatchObject({ code: 'CONTRACT' });
    await expect(
      createNotificationClient(transport(404, { error: { code: 'NOT_FOUND' } })).markRead(id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
  it('renders first paint readable without scripts, disables actions until interactive and escapes nothing unsafe', () => {
    const html = renderToStaticMarkup(createElement(NotificationsPanel, { initial: state }));
    expect(html).toContain('Your submission has a review decision.');
    expect(html).toContain('1 unread.');
    expect(html).toContain('href="/raider/work"');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('cannot be turned off');
    const empty = renderToStaticMarkup(
      createElement(NotificationsPanel, { initial: { ...state, items: [], unread: 0 } }),
    );
    expect(empty).toContain('No notifications yet.');
  });
});
