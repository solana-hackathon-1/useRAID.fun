import Link from 'next/link';
export default function GuildNotFound() {
  return (
    <div className="empty">
      <h1>Guild not found</h1>
      <p>This Guild does not exist or is not public.</p>
      <Link className="button" href="/">
        Back to home
      </Link>
    </div>
  );
}
