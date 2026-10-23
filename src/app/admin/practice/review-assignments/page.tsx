import { notFound } from 'next/navigation';
import { PracticeAssignmentManager } from '../../../../components/practice-assignment-manager';
import { practiceAssignmentManagementHandlers } from '../../../../lib/practice-assignment-management';
import { createPracticeAssignmentManagementLoader } from '../../../../skills/practice-assignment-management-page';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = {
  title: 'Review appointments',
  description: 'Private administrator review appointment management.',
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = await createPracticeAssignmentManagementLoader(
    practiceAssignmentManagementHandlers.GET,
  )(await searchParams);
  if (state.status === 'NOT_FOUND') notFound();
  return (
    <div className="studio">
      <h1>Review appointments</h1>
      {state.status === 'READY' ? (
        <PracticeAssignmentManager key={state.context.page.accessId} context={state.context} />
      ) : (
        <section className="orientation-card">
          <p role="alert">
            {state.status === 'SIGN_IN'
              ? 'Sign in with an authorized X administrator session.'
              : state.status === 'DENIED'
                ? 'Appointment management is unavailable for your account.'
                : state.status === 'RATE_LIMITED'
                  ? 'Too many requests. Wait before rechecking.'
                  : 'Appointment management is currently unavailable. Try again later.'}
          </p>
          <a className="button secondary" href="/creator/account">
            Account
          </a>
        </section>
      )}
    </div>
  );
}
