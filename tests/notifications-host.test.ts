import { afterEach, expect, it, vi } from 'vitest';

const port = vi.hoisted(() => ({
  tx: {},
  state: vi.fn(),
  mark: vi.fn(),
  setPrefs: vi.fn(),
  events: vi.fn(),
  reminders: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (tx: object) => unknown) => work(port.tx),
}));
vi.mock('../src/notifications/storage', () => ({
  readOwnNotificationState: port.state,
  markNotificationRead: port.mark,
  setNotificationPreferences: port.setPrefs,
  dispatchWorkNotifications: port.events,
  dispatchDeadlineReminders: port.reminders,
}));
import {
  markReadFromHost,
  notificationStateFromHost,
  notificationsConfiguration,
  runNotificationDispatch,
  setPreferencesFromHost,
} from '../src/lib/notifications-host';

const actor = { accountId: 'a', sessionHash: 'a'.repeat(64) };
afterEach(() => {
  delete process.env.NOTIFICATIONS_READS_ENABLED;
  delete process.env.NOTIFICATIONS_DISPATCH_ENABLED;
  vi.clearAllMocks();
});
it('is off by default; only exact "true" enables reads or dispatch', async () => {
  expect(notificationsConfiguration()).toEqual({ readsAvailable: false, dispatchAvailable: false });
  process.env.NOTIFICATIONS_READS_ENABLED = '1';
  process.env.NOTIFICATIONS_DISPATCH_ENABLED = 'TRUE';
  expect(notificationsConfiguration()).toEqual({ readsAvailable: false, dispatchAvailable: false });
  await expect(notificationStateFromHost(actor)).rejects.toMatchObject({
    code: 'STORAGE_CONTRACT',
  });
  await expect(markReadFromHost(actor, 'x')).rejects.toMatchObject({ code: 'STORAGE_CONTRACT' });
  await expect(setPreferencesFromHost(actor, { promotional: true })).rejects.toMatchObject({
    code: 'STORAGE_CONTRACT',
  });
  expect(await runNotificationDispatch()).toBeNull();
  expect(port.events).not.toHaveBeenCalled();
});
it('returns the person’s list with their preferences when reads are on', async () => {
  process.env.NOTIFICATIONS_READS_ENABLED = 'true';
  const state = { version: 'v1', items: [], unread: 0, preferences: { promotional: false } };
  port.state.mockResolvedValue(state);
  expect(await notificationStateFromHost(actor)).toEqual(state);
  expect(port.state).toHaveBeenCalledWith(port.tx, actor);
});
it('runs one bounded dispatch pass only when explicitly enabled', async () => {
  process.env.NOTIFICATIONS_DISPATCH_ENABLED = 'true';
  port.events.mockResolvedValue({ handled: 2, created: 3 });
  port.reminders.mockResolvedValue({ created: 1 });
  expect(await runNotificationDispatch()).toEqual({
    events: { handled: 2, created: 3 },
    reminders: { created: 1 },
  });
  expect(port.events).toHaveBeenCalledWith(port.tx, { limit: 100 });
  expect(port.reminders).toHaveBeenCalledWith(port.tx, { withinHours: 24, limit: 100 });
});
