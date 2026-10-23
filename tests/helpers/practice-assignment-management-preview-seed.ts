import { writeFile } from 'node:fs/promises';
import {
  seedPracticeAssignmentManagementFixture,
  db,
} from './practice-assignment-management-browser-fixture';
if (process.env.RAID_MANAGEMENT_PREVIEW !== 'synthetic-only')
  throw new Error('Explicit synthetic fixture mode required');
const output = process.env.RAID_MANAGEMENT_PREVIEW_FILE;
if (!output?.startsWith('/tmp/raid-management-preview-'))
  throw new Error('Owned temporary output required');
try {
  const f = await seedPracticeAssignmentManagementFixture();
  await writeFile(output, JSON.stringify({ cookie: f.managerCookie, path: f.path }), {
    mode: 0o600,
  });
} finally {
  await db.$disconnect();
}
