import { WorkError, type WorkActor } from '../work-loop/contracts';
import {
  dispatchDeadlineReminders,
  dispatchWorkNotifications,
  markNotificationRead,
  readOwnNotificationState,
  setNotificationPreferences,
} from '../notifications/storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';

const flag = (name: string) => process.env[name] === 'true';
/** Both default off. In-app work notifications only; no email, social or push provider is configured. */
export function notificationsConfiguration() {
  return {
    readsAvailable: flag('NOTIFICATIONS_READS_ENABLED'),
    dispatchAvailable: flag('NOTIFICATIONS_DISPATCH_ENABLED'),
  };
}
function requireReads() {
  if (!notificationsConfiguration().readsAvailable) throw new WorkError('STORAGE_CONTRACT');
}
export async function notificationStateFromHost(actor: WorkActor) {
  requireReads();
  return runCommandTransaction(db, (tx) => readOwnNotificationState(tx, actor));
}
export async function markReadFromHost(actor: WorkActor, id: string) {
  requireReads();
  return runCommandTransaction(db, (tx) => markNotificationRead(tx, actor, id));
}
export async function setPreferencesFromHost(actor: WorkActor, value: { promotional: boolean }) {
  requireReads();
  return runCommandTransaction(db, (tx) => setNotificationPreferences(tx, actor, value));
}
/** Worker entry: one bounded pass of outbox notifications and deadline reminders. Off unless explicitly enabled. */
export async function runNotificationDispatch() {
  if (!notificationsConfiguration().dispatchAvailable) return null;
  return runCommandTransaction(db, async (tx) => ({
    events: await dispatchWorkNotifications(tx, { limit: 100 }),
    reminders: await dispatchDeadlineReminders(tx, { withinHours: 24, limit: 100 }),
  }));
}
