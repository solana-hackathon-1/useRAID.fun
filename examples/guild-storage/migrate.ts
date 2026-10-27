import { readFile } from 'node:fs/promises';
import { pool } from './connection';
const client = await pool.connect();
try {
  for (const file of [
    'schema.sql',
    'migrations/receipts.sql',
    'migrations/drafts.sql',
    'migrations/guilds.sql',
  ])
    await client.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  console.log(
    'Independent synthetic host tables and owned receipt/draft/Guild migrations applied.',
  );
} finally {
  client.release();
  await pool.end();
}
