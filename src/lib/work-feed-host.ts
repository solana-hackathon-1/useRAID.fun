import { readWorkFeed } from '../work-loop/feed-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';

/** Exact-string flag, default off: a closed feature advertises and answers nothing. */
export function workFeedAvailable() {
  return process.env.WORK_FEED_READS_ENABLED === 'true';
}
export async function readFeedFromHost(query: unknown) {
  return runCommandTransaction(db, (tx) => readWorkFeed(tx, query));
}
