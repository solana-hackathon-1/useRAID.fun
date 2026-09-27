import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="empty">
      <h1>This signal couldn’t be found.</h1>
      <p>The campaign may have ended or been removed.</p>
      <Link className="button" href="/">
        Explore campaigns
      </Link>
    </div>
  );
}
