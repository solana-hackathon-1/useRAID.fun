import 'dotenv/config';
import { spawnSync, spawn } from 'node:child_process';
const database = new URL(process.env.DATABASE_URL || 'http://invalid');
if (!['localhost', '127.0.0.1'].includes(database.hostname))
  throw Error('Preview requires local PostgreSQL.');
const probe = spawnSync(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'useraid',
    '-d',
    'postgres',
    '-Atc',
    "SELECT 1 FROM pg_database WHERE datname='useraid_studio_test'",
  ],
  { encoding: 'utf8' },
);
if (probe.status !== 0) throw Error('Start local database with docker compose up -d db.');
if (
  !probe.stdout.trim() &&
  spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'createdb', '-U', 'useraid', 'useraid_studio_test'],
    { stdio: 'inherit' },
  ).status !== 0
)
  throw Error('Cannot create test database.');
database.pathname = '/useraid_studio_test';
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: database.toString(),
  NODE_ENV: 'development',
  STUDIO_SANDBOX: 'true',
  NEXT_DIST_DIR: '.next-studio',
  DEMO_MODE: 'false',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3007',
  APP_URL: 'http://localhost:3007',
  X_TRACKING_V2_ENABLED: 'true',
};
if (spawnSync('npx', ['prisma', 'migrate', 'deploy'], { env, stdio: 'inherit' }).status !== 0)
  throw Error('Test migration failed.');
console.log('Isolated Studio test: http://localhost:3007/studio-test');
const child = spawn('npx', ['next', 'dev', '--hostname', '127.0.0.1', '--port', '3007'], {
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code || 0));
