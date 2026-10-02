import Link from 'next/link';
export const dynamic = 'force-dynamic';
export default async function LaunchPage() {
  return (
    <section className="panel access-card">
      <span className="status-pill">Coming soon</span>
      <h1>Launchpads</h1>
      <p>
        Token creation, creator-fee collection, trading, and automated reward payouts are coming
        soon.
      </p>
      <p>Create Raids for existing projects, join campaigns, and track verified X contributions.</p>
      <Link className="button" href="/creator">
        Create a Raid
      </Link>
    </section>
  );
}
