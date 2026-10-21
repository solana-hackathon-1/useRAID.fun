import Link from 'next/link';
import { PracticeTrialCatalog } from '@/components/practice-trial-portal';
import { loadPracticeCatalog } from '@/lib/practice-portal-page';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Practice trials',
  robots: { index: false, follow: false },
  description:
    'Unpaid practice with public or synthetic material. Practice does not verify a rank.',
};
export default async function PracticePage() {
  const page = await loadPracticeCatalog();
  if (page.status === 'SIGN_IN')
    return (
      <div className="studio">
        <h1>Practice trials</h1>
        <p>Sign in to view and start practice trials.</p>
        <Link className="button" href="/creator/account">
          Sign in
        </Link>
      </div>
    );
  return (
    <div className="studio">
      <h1>Practice trials</h1>
      <PracticeTrialCatalog
        initial={page.status === 'READY' ? page.catalog : null}
        readsAvailable={page.status === 'READY'}
        writesAvailable={page.status === 'READY' && page.writesAvailable}
      />
      <p>
        <Link className="inline-link" href="/raider/skills">
          Private skill claims
        </Link>
      </p>
      <p>
        <Link className="inline-link" href="/raider/onboarding">
          Raider orientation
        </Link>
      </p>
    </div>
  );
}
