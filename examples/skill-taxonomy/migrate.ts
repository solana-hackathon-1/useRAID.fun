import { readFile } from 'node:fs/promises';
import { pool } from './connection';
const client = await pool.connect();
try {
  for (const file of ['schema.sql', 'migrations/receipts.sql', 'migrations/taxonomy.sql'])
    await client.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  console.log('Independent account/session/receipt/admin-catalog schema applied.');
} finally {
  client.release();
  await pool.end();
}
