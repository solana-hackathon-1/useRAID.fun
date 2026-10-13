import { readFile } from 'node:fs/promises';
import { pool } from './connection';
const client = await pool.connect();
try {
  await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  await client.query(
    await readFile(new URL('./migrations/participant.sql', import.meta.url), 'utf8'),
  );
  await client.query(
    'ALTER TABLE "Participant" ADD CONSTRAINT "Participant_id_accountId_key" UNIQUE ("id", "accountId")',
  );
  await client.query(await readFile(new URL('./migrations/receipts.sql', import.meta.url), 'utf8'));
  await client.query(
    await readFile(new URL('./migrations/preferences.sql', import.meta.url), 'utf8'),
  );
  console.log('Independent synthetic host schema and owned migrations applied.');
} finally {
  client.release();
  await pool.end();
}
