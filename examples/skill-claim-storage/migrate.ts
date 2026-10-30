import { readFile } from 'node:fs/promises';
import { pool } from './connection';
const client = await pool.connect();
try {
  for (const file of [
    'schema.sql',
    'migrations/participant.sql',
    'participant-index.sql',
    'migrations/receipts.sql',
    'migrations/taxonomy.sql',
    'migrations/claims.sql',
    'migrations/evidence-fingerprints.sql',
  ])
    await client.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  console.log(
    'Independent canonical HUMAN/account/session/receipt/catalog/private-claim schema applied.',
  );
} finally {
  client.release();
  await pool.end();
}
