import 'dotenv/config';
import { db } from '../src/lib/db';
import { buildAuditReport } from '../src/lib/audit';
if (!process.env.DATABASE_URL) {
  console.error('Audit unavailable: DATABASE_URL is not configured. No deployment was contacted.');
  process.exitCode = 1;
} else {
  try {
    const report = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return buildAuditReport(tx);
    });
    console.log(JSON.stringify({ auditedAt: new Date().toISOString(), ...report }, null, 2));
  } catch (error) {
    console.error('Read-only deployment audit failed. Check connectivity and migration state.');
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
