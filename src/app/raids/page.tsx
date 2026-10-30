import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WorkFeed } from '@/components/work-feed';
import { loadFeed } from '@/lib/work-feed-page';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Live Raids',
  description: 'Browse funded, open work from Guilds.',
};
export default async function RaidsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const loaded = await loadFeed(await searchParams);
  if (loaded.status === 'UNAVAILABLE') notFound();
  if (loaded.status === 'INVALID')
    return (
      <div className="studio">
        <h1>Live Raids</h1>
        <p role="alert">Those filters are not valid.</p>
        <Link className="button secondary" href="/raids">
          Show all live Raids
        </Link>
      </div>
    );
  return (
    <div className="studio">
      <WorkFeed page={loaded.page} query={loaded.query} viewer={loaded.viewer} />
    </div>
  );
}
