import type { Prisma } from '@prisma/client';
import type { TargetPreview } from '@/lib/studio-targets';
export function TargetPosts({
  posts,
  handle,
  active,
}: {
  posts: { id: string; preview: Prisma.JsonValue }[];
  handle: string;
  active: boolean;
}) {
  if (!posts.length) return null;
  return (
    <section className="studio-section">
      <h2>Raid these posts</h2>
      <p>Quote or link a target post and include @{handle} in your own text.</p>
      <div className="studio-target-list">
        {posts.map((post) => {
          const preview = post.preview as TargetPreview | null,
            url = `https://x.com/i/web/status/${post.id}`;
          const compose = new URL('https://x.com/intent/post');
          compose.searchParams.set('text', `@${handle}\n\n${url}`);
          return (
            <article key={post.id} className="studio-target">
              <strong>{preview?.handle ? `@${preview.handle}` : 'X post'}</strong>
              <p>{preview?.text || 'Open target post on X to see current content.'}</p>
              <a className="inline-link" href={url} target="_blank" rel="noreferrer">
                View post
              </a>
              {active && (
                <div className="form-actions">
                  <a
                    className="button secondary small"
                    href={compose.toString()}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Create quote
                  </a>
                  <a
                    className="inline-link"
                    href={compose.toString()}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Write a post
                  </a>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
