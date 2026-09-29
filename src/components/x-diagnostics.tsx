import { db } from '@/lib/db';
import { oauthConfig } from '@/lib/x-oauth';

// Call only from development Creator studio or an authorized admin page.
export async function XDiagnostics({ userId }: { userId?: string }) {
  let configured = false,
    database = false;
  let account: { xUserId: string; updatedAt: Date } | null = null;
  try {
    oauthConfig();
    configured = true;
  } catch {}
  try {
    await db.$queryRaw`SELECT 1`;
    account = userId
      ? await db.xAccount.findUnique({
          where: { userId },
          select: { xUserId: true, updatedAt: true },
        })
      : null;
    database = true;
  } catch {}
  return (
    <section className="panel" aria-label="OAuth diagnostics">
      <h2>OAuth diagnostics</h2>
      <p>OAuth configuration: {configured ? 'OK' : 'Unavailable'}</p>
      <p>X authorization: {account ? 'OK (last successful connection)' : 'Not verified'}</p>
      <p>X user lookup: {account ? 'OK (last successful connection)' : 'Not verified'}</p>
      <p>X user ID: {account ? `detected (${account.xUserId})` : 'Not detected'}</p>
      <p>Database connection: {database ? 'OK' : 'Unavailable'}</p>
      {account && <p className="small-print">Last verified: {account.updatedAt.toISOString()}</p>}
    </section>
  );
}
