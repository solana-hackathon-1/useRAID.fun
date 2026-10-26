'use client';
import { useState, useSyncExternalStore } from 'react';
import { createNotificationClient, type NotificationClient } from '../notifications/client';
import type { NotificationState } from '../notifications/contracts';

const defaultClient = createNotificationClient();
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
function when(value: string) {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value)) + ' UTC'
  );
}
export function NotificationsPanel({
  initial,
  client = defaultClient,
}: {
  initial: NotificationState;
  client?: NotificationClient;
}) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const [state, setState] = useState(initial);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setState(await client.state());
  }
  async function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setProblem('');
    try {
      await work();
      await refresh();
    } catch {
      setProblem('That did not go through. Nothing was lost; try again.');
    } finally {
      setBusy(false);
    }
  }
  // The choice shows at once and is undone with a clear message if the server did not keep it.
  async function choose(promotional: boolean) {
    if (busy) return;
    const previous = state.preferences;
    setState({ ...state, preferences: { promotional } });
    setBusy(true);
    setProblem('');
    try {
      await client.setPreferences(promotional);
    } catch {
      setState({ ...state, preferences: previous });
      setProblem('That did not go through. Your previous choice is kept.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="orientation-card">
      <h2 id="notifications-title">Notifications</h2>
      <p className="orientation-hint" role="status">
        {state.unread === 0 ? 'Nothing new.' : `${state.unread} unread.`} Messages never include the
        details of your work.
      </p>
      {problem && <p role="alert">{problem}</p>}
      {state.items.length === 0 ? (
        <p>No notifications yet.</p>
      ) : (
        <ul aria-labelledby="notifications-title">
          {state.items.map((item) => (
            <li key={item.id}>
              <p>
                {!item.read && <strong>New: </strong>}
                {item.message} <span className="orientation-hint">{when(item.createdAt)}</span>
              </p>
              <a className="inline-link" href={item.link}>
                Open
              </a>{' '}
              {!item.read && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={!ready || busy}
                  onClick={() => run(() => client.markRead(item.id))}
                >
                  Mark as read
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => e.preventDefault()} aria-label="Notification preferences">
        <fieldset className="orientation-fields" disabled={!ready || busy}>
          <legend>Preferences</legend>
          <label>
            <input
              type="checkbox"
              checked={state.preferences.promotional}
              onChange={(e) => choose(e.target.checked)}
            />{' '}
            Send me optional discovery and promotional notifications
          </label>
          <span className="orientation-hint">
            Notifications about your own work are always shown here and cannot be turned off.
          </span>
        </fieldset>
      </form>
    </div>
  );
}
