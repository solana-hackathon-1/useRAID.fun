import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { guildPublicAvailable } from '@/lib/guild-public-host';
import { GuildPublicPageThrottled, loadGuildDirectory } from '@/lib/guild-public-page';

// Read per request, never from a shared cache.
export const dynamic = 'force-dynamic';
type Props = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };
// Pre-launch and without unlisting (OPEN), the directory asks search engines not to index it, like Guild pages.
const robots = { index: false, follow: false };
const description = 'Public Guild profiles on RAID.';
const EXCERPT = 200;
const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT ? flat.slice(0, EXCERPT).trimEnd() + '…' : flat;
};
export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Guilds', description, robots };
}
export default async function GuildDirectoryPage({ searchParams }: Props) {
  if (!guildPublicAvailable())
    return (
      <div className="empty">
        <h1>Guilds</h1>
        <p>The Guild directory is not open yet.</p>
        <Link className="button" href="/">
          Back to home
        </Link>
      </div>
    );
  let view;
  try {
    view = await loadGuildDirectory((await searchParams).after);
  } catch (error) {
    if (error instanceof GuildPublicPageThrottled)
      return (
        <div className="empty">
          <h1>Too many requests</h1>
          <p>This page is being requested too often from your connection. Try again shortly.</p>
        </div>
      );
    throw error;
  }
  if (!view) notFound();
  const { guilds, nextCursor, after } = view;
  return (
    <>
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Home</Link>
        <span aria-hidden="true">/</span>
        <span>Guilds</span>
      </nav>
      <header className="page-title">
        <h1>Guilds</h1>
        <p className="muted">Browse public Guild profiles, sorted by address.</p>
      </header>
      <section className="panel" aria-labelledby="guild-directory-heading">
        <h2 id="guild-directory-heading">{after ? 'More Guilds' : 'All Guilds'}</h2>
        {guilds.length ? (
          <ul className="guild-directory">
            {guilds.map((guild) => (
              <li key={guild.slug}>
                <article>
                  <h3>
                    <Link href={`/guilds/${guild.slug}`}>{guild.name}</Link>
                  </h3>
                  <p className="muted">{guild.slug}</p>
                  {guild.description && (
                    <p className="campaign-copy">{excerpt(guild.description)}</p>
                  )}
                </article>
              </li>
            ))}
          </ul>
        ) : (
          <p>{after ? 'No more Guilds.' : 'No Guilds are listed yet.'}</p>
        )}
        {(nextCursor || after) && (
          <nav className="detail-actions guild-directory-nav" aria-label="Guild pages">
            {nextCursor && (
              <Link
                className="button secondary"
                href={`/guilds?after=${nextCursor}`}
                prefetch={false}
              >
                Load more Guilds
              </Link>
            )}
            {after && (
              <Link className="guild-directory-back" href="/guilds">
                Back to first Guilds
              </Link>
            )}
          </nav>
        )}
      </section>
    </>
  );
}
