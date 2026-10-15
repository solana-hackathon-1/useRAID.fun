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
    'migrations/practice.sql',
    'migrations/starts.sql',
    'migrations/submissions.sql',
    'migrations/review-assignments.sql',
    'migrations/policies.sql',
    'migrations/ownership.sql',
    'migrations/assessments.sql',
  ])
    await client.query(await readFile(new URL(file, import.meta.url), 'utf8'));
  console.log(
    'Independent account/session/HUMAN/receipt/catalog/practice/rubric/start/private-submission schema applied.',
  );
} finally {
  client.release();
  await pool.end();
}
