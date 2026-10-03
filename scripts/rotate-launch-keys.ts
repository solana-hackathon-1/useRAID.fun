import 'dotenv/config';
import { db } from '../src/lib/db';
import { rotateLaunchKeys } from '../src/lib/launch-rotation';
if (!process.env.DATABASE_URL) {
  console.error('Rotation unavailable: DATABASE_URL is not configured.');
  process.exitCode = 1;
} else {
  const apply = process.argv.includes('--apply');
  try {
    const counts = await rotateLaunchKeys({ apply });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...counts }));
    if (counts.failed) process.exitCode = 1;
  } catch (error) {
    console.error('Key rotation failed.', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
