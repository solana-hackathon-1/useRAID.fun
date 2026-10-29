const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'db'];

// `useraid_test`, or `useraid_test_<suffix>` so parallel checkouts can each keep a disposable database.
const TEST_DATABASE = /^useraid_test(_[a-z0-9]+)*$/;

export function assertTestDatabase(name?: string, url = process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === 'production')
    throw Error('Refusing to run database fixtures with NODE_ENV=production.');
  let parsed: URL;
  try {
    parsed = new URL(url || 'http://invalid');
  } catch {
    throw Error(`Use a dedicated ${name ?? 'useraid_test'} database.`);
  }
  const actual = parsed.pathname.slice(1);
  if (name === undefined ? !TEST_DATABASE.test(actual) : parsed.pathname !== `/${name}`)
    throw Error(`Use a dedicated ${name ?? 'useraid_test'} database.`);
  if (!LOCAL_HOSTS.includes(parsed.hostname) && process.env.ALLOW_REMOTE_TEST_DB !== 'true')
    throw Error(
      `Refusing to use remote host ${parsed.hostname}; set ALLOW_REMOTE_TEST_DB=true to override.`,
    );
}

/** The validated name of the database in `url`, safe to quote in an `ALTER DATABASE` statement. */
export function testDatabaseName(url = process.env.DATABASE_URL) {
  assertTestDatabase(undefined, url);
  return new URL(url as string).pathname.slice(1);
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
