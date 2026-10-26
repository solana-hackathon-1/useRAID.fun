import Link from 'next/link';
import { NotificationsPanel } from '@/components/notifications-panel';
import { loadNotifications } from '@/lib/notifications-page';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Notifications',
  robots: { index: false, follow: false },
  description: 'Your Raid notifications.',
};
export default async function NotificationsPage() {
  const page = await loadNotifications();
  return (
    <div className="studio">
      <h1>Notifications</h1>
      {page.status === 'SIGN_IN' ? (
        <>
          <p>Sign in to see your notifications.</p>
          <Link className="button" href="/creator/account">
            Sign in
          </Link>
        </>
      ) : page.status === 'UNAVAILABLE' ? (
        <p role="status">Notifications are currently unavailable. Try again later.</p>
      ) : (
        <NotificationsPanel initial={page.state} />
      )}
    </div>
  );
}
