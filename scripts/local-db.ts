import { spawnSync } from 'node:child_process';

export function checkLocalUrl(url: string | undefined, name: string) {
  if (process.env.NODE_ENV === 'production')
    throw Error('Refusing to prepare a local database with NODE_ENV=production.');
  let parsed: URL;
  try {
    parsed = new URL(url || 'http://invalid');
  } catch {
    throw Error('DATABASE_URL is not a valid URL.');
  }
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname))
    throw Error('Preview requires local PostgreSQL.');
  if (parsed.pathname !== `/${name}`) throw Error(`Use a dedicated ${name} database.`);
  return parsed;
}

const compose = (args: string[], options: Parameters<typeof spawnSync>[2] = {}) =>
  spawnSync('docker', ['compose', 'exec', '-T', 'db', ...args], { encoding: 'utf8', ...options });

export function ensureLocalDatabase(name: string, url = process.env.DATABASE_URL) {
  checkLocalUrl(url, name);
  const probe = compose([
    'psql',
    '-U',
    'useraid',
    '-d',
    'postgres',
    '-Atc',
    `SELECT 1 FROM pg_database WHERE datname='${name}'`,
  ]);
  if (probe.status !== 0) throw Error('Start local database with docker compose up -d db.');
  if (
    !String(probe.stdout).trim() &&
    compose(['createdb', '-U', 'useraid', name], { stdio: 'inherit' }).status !== 0
  )
    throw Error('Cannot create test database.');
  const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
  if (migrate.status !== 0) throw Error('Test migration failed.');
}
