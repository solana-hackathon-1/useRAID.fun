import 'dotenv/config';
import { db } from './lib/db';
import { config } from './lib/config';
import { claimJob } from './lib/queue';
import { assertSchemaCurrent, runJob, schedule } from './lib/worker-jobs';
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
async function main() {
  if (config.demo) throw new Error('Worker cannot run in demo mode.');
  await assertSchemaCurrent();
  let scheduled = 0;
  while (!stopping) {
    try {
      if (Date.now() - scheduled > 60000) {
        scheduled = Date.now();
        try {
          await schedule();
        } catch (error) {
          console.error(
            JSON.stringify({
              schedule: 'failed',
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      const job = await claimJob();
      if (!job) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      await runJob(job);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Worker failed');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
