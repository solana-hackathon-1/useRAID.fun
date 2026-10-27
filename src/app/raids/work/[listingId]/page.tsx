import { notFound } from 'next/navigation';
import { WorkDetail } from '@/components/work-feed';
import { applyMode, loadDetail } from '@/lib/work-feed-page';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Raid details',
  description: 'The full public brief of a live Raid.',
};
export default async function RaidDetailPage({
  params,
}: {
  params: Promise<{ listingId: string }>;
}) {
  const loaded = await loadDetail((await params).listingId);
  if (loaded.status !== 'READY') notFound();
  return (
    <div className="studio">
      <WorkDetail detail={loaded.detail} apply={await applyMode(loaded.detail)} />
    </div>
  );
}
