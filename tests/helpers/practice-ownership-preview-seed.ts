import { writeFile } from 'node:fs/promises';
import { seedPracticeOwnershipFixture, db } from './practice-ownership-browser-fixture';
if (process.env.RAID_OWNERSHIP_PREVIEW !== 'synthetic-only')
  throw Error('Explicit synthetic fixture mode required');
const output = process.env.RAID_OWNERSHIP_PREVIEW_FILE;
if (!output?.startsWith('/tmp/raid-ownership-ui-preview-'))
  throw Error('Owned temporary output required');
try {
  const fixture = await seedPracticeOwnershipFixture(true, 8 * 3600000);
  await db.session.update({
    where: { tokenHash: fixture.sessionHash },
    data: { expiresAt: new Date(Date.now() + 8 * 3600000) },
  });
  await writeFile(output, JSON.stringify({ cookie: fixture.cookie, path: fixture.path }), {
    mode: 0o600,
  });
} finally {
  await db.$disconnect();
}
