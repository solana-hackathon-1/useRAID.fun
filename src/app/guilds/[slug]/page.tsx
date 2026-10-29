import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatUtcDateTime } from '@/lib/format';
import { loadGuildPublicPage, loadGuildPublicProfile } from '@/lib/guild-public-page';

// Read per request, never from a shared cache: a withdrawn update must disappear at once.
export const dynamic = 'force-dynamic';
type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};
// Pre-launch and without unlisting (OPEN), Guild pages ask search engines not to index them.
const robots = { index: false, follow: false };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const guild = await loadGuildPublicProfile((await params).slug);
  if (!guild) return { title: 'Guild not found', robots };
  return {
    title: guild.name,
    description: guild.description.replace(/\s+/g, ' ').trim().slice(0, 300),
    robots,
  };
}
export default async function GuildPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const view = await loadGuildPublicPage(slug, (await searchParams).before);
  if (!view) notFound();
  const { guild, updates, nextCursor, before } = view;
  const home = `/guilds/${guild.slug}`;
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Home</Link>
        <span aria-hidden="true">/</span>
        <span>Guilds</span>
      </nav>
      <header className="page-title">
        <p className="muted">Guild · {guild.slug}</p>
        <h1>{guild.name}</h1>
        {guild.description && <p className="campaign-copy">{guild.description}</p>}
        {guild.primaryTokenMint && (
          <p className="muted">
            Primary token mint <code>{guild.primaryTokenMint}</code>
          </p>
        )}
      </header>
      <section className="panel" aria-labelledby="guild-updates-heading">
        <h2 id="guild-updates-heading">{before ? 'Older updates' : 'Updates'}</h2>
        {updates.length ? (
          <ol className="guild-updates">
            {updates.map((update) => (
              <li key={update.id}>
                <article>
                  <h3>{update.title}</h3>
                  <p className="muted">
                    Published{' '}
                    <time dateTime={update.publishedAt}>
                      {formatUtcDateTime(update.publishedAt)}
                    </time>
                  </p>
                  <p className="campaign-copy">{update.body}</p>
                </article>
              </li>
            ))}
          </ol>
        ) : (
          <p>{before ? 'No older updates.' : 'No published updates yet.'}</p>
        )}
        {(nextCursor || before) && (
          <nav className="detail-actions" aria-label="Update pages">
            {nextCursor && (
              <Link
                className="button secondary"
                href={`${home}?before=${nextCursor}`}
                prefetch={false}
              >
                Load more updates
              </Link>
            )}
            {before && <Link href={home}>Back to latest updates</Link>}
          </nav>
        )}
      </section>
    </>
  );
}
