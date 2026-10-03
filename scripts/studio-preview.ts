import 'dotenv/config';
import { spawn } from 'node:child_process';
import { ensureLocalDatabase } from './local-db';
const database = new URL(process.env.DATABASE_URL || 'http://invalid');
if (!['localhost', '127.0.0.1'].includes(database.hostname))
  throw Error('Preview requires local PostgreSQL.');
database.pathname = '/useraid_studio_test';
ensureLocalDatabase('useraid_studio_test', database.toString());
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
console.log('Isolated Studio test: http://localhost:3007/studio-test');
const child = spawn('npx', ['next', 'dev', '--hostname', '127.0.0.1', '--port', '3007'], {
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code || 0));
