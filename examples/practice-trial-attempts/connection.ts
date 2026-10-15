import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// Explicit driver boundary avoids leaking vendor types into the domain port.
interface Client {
  query<Row>(sql: string, bindings?: readonly (string | null)[]): Promise<{ rows: Row[] }>;
  release(): void;
}
interface Pool {
  connect(): Promise<Client>;
  end(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { Pool } = require('pg') as { Pool: new (options: { connectionString: string }) => Pool };
const url = new URL(process.env.DATABASE_URL ?? 'http://missing');
assert(['postgresql:', 'postgres:'].includes(url.protocol));
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
assert.equal(url.pathname, '/useraid_practice_attempt_host_test');
assert.notEqual(process.env.NODE_ENV, 'production');
export const pool = new Pool({ connectionString: url.toString() });
