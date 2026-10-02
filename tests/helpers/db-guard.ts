const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'db'];

export function assertTestDatabase(name = 'useraid_test', url = process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === 'production')
    throw Error('Refusing to run database fixtures with NODE_ENV=production.');
  let parsed: URL;
  try {
    parsed = new URL(url || 'http://invalid');
  } catch {
    throw Error(`Use a dedicated ${name} database.`);
  }
  if (parsed.pathname !== `/${name}`) throw Error(`Use a dedicated ${name} database.`);
  if (!LOCAL_HOSTS.includes(parsed.hostname) && process.env.ALLOW_REMOTE_TEST_DB !== 'true')
    throw Error(
      `Refusing to use remote host ${parsed.hostname}; set ALLOW_REMOTE_TEST_DB=true to override.`,
    );
}

type RawClient = {
  $queryRawUnsafe: (query: string) => Promise<unknown>;
  $executeRawUnsafe: (query: string) => Promise<unknown>;
};

export async function truncateAll(db: RawClient) {
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const tables = (await db.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  )) as { tablename: string }[];
  if (!tables.length) return;
  const filled = (await db.$queryRawUnsafe(
    tables
      .map(
        ({ tablename }) =>
          `SELECT '${tablename.replaceAll("'", "''")}' AS tablename WHERE EXISTS (SELECT 1 FROM ${quote(tablename)})`,
      )
      .join(' UNION ALL '),
  )) as { tablename: string }[];
  if (filled.length)
    await db.$executeRawUnsafe(
      `TRUNCATE ${filled.map(({ tablename }) => quote(tablename)).join(', ')} CASCADE`,
    );
}
