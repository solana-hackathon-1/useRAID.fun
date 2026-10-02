import 'dotenv/config';
import { db } from './lib/db';
import { config } from './lib/config';
import { claimJob } from './lib/queue';
import { runJob, schedule } from './lib/worker-jobs';
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
async function main() {
  if (config.demo) throw new Error('Worker cannot run in demo mode.');
  let scheduled = 0;
  while (!stopping) {
    try {
      if (Date.now() - scheduled > 60000) {
        await schedule();
        scheduled = Date.now();
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
