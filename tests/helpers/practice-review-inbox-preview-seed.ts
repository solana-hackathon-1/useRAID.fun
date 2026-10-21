import { writeFile } from 'node:fs/promises';
import { seedPracticeReviewInboxFixture, db } from './practice-review-inbox-fixture';
if (process.env.RAID_INBOX_PREVIEW !== 'synthetic-only')
  throw new Error('Explicit synthetic fixture mode required');
const output = process.env.RAID_INBOX_PREVIEW_FILE;
if (!output?.startsWith('/tmp/raid-review-inbox-preview-'))
  throw new Error('Owned temporary output required');
try {
  const f = await seedPracticeReviewInboxFixture();
  await writeFile(output, JSON.stringify({ cookie: f.cookie, path: '/evaluator/practice' }), {
    mode: 0o600,
  });
} finally {
  await db.$disconnect();
}
