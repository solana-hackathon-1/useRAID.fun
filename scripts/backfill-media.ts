import 'dotenv/config';
import { db } from '../src/lib/db';
import { backfillMedia } from '../src/lib/media';
if (!process.env.DATABASE_URL) {
  console.error('Backfill unavailable: DATABASE_URL is not configured.');
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await backfillMedia()));
  } catch (error) {
    console.error('Media backfill failed.', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
