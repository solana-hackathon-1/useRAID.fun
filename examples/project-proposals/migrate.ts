import { readFile } from 'node:fs/promises';
import { pool } from './connection';
const client = await pool.connect();
try {
  for (const file of [
    'schema.sql',
    'migrations/receipts.sql',
    'migrations/drafts.sql',
    'migrations/proposals.sql',
  ])
    await client.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  console.log('Independent owned account/session/receipt/draft/pending-proposal schema applied.');
} finally {
  client.release();
  await pool.end();
}
