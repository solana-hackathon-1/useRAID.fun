import { writeFile } from 'node:fs/promises';
import { seedPracticeReviewFixture, db } from './practice-review-browser-fixture';
if (process.env.RAID_REVIEW_PREVIEW !== 'synthetic-only')
  throw new Error('Explicit synthetic fixture mode required');
const output = process.env.RAID_REVIEW_PREVIEW_FILE;
if (!output?.startsWith('/tmp/raid-review-ui-preview-'))
  throw new Error('Owned temporary output required');
try {
  const f = await seedPracticeReviewFixture({ expiresMs: 8 * 3600000 });
  await db.session.update({
    where: { tokenHash: f.sessionHash },
    data: { expiresAt: new Date(Date.now() + 8 * 3600000) },
  });
  await writeFile(output, JSON.stringify({ cookie: f.cookie, path: f.path }), { mode: 0o600 });
} finally {
  await db.$disconnect();
}
