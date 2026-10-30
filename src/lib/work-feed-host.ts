import { readWorkDetail, readWorkFeed } from '../work-loop/feed-storage';
import { attachPublicGuilds } from './work-feed-guilds';
import type { WorkActor } from '../work-loop/contracts';
import { guildPublicAvailable } from './guild-public-host';
import { runCommandTransaction } from './command-receipts-adapter';
import { db } from './db';
import { createViewerEvaluator } from './work-feed-viewer';

/** Exact-string flag, default off: a closed feature advertises and answers nothing. */
export function workFeedAvailable() {
  return process.env.WORK_FEED_READS_ENABLED === 'true';
}
/** The one published taxonomy Raid terms name skills from; the same setting acceptance uses. */
function eligibilityTaxonomy() {
  return (process.env.WORK_ACCEPTANCE_TAXONOMY_ID ?? '').trim();
}
/** Exact-string flag, default off, and closed until the shared taxonomy is configured. */
export function workFeedEligibilityAvailable() {
  return process.env.WORK_FEED_ELIGIBILITY_ENABLED === 'true' && eligibilityTaxonomy() !== '';
}
/** Guild names and links appear only while public Guild reads are on, exactly as the Guild page itself. */
async function withGuilds<T extends { guildId: string }>(
  tx: Parameters<typeof attachPublicGuilds>[0],
  cards: T[],
) {
  return guildPublicAvailable() ? attachPublicGuilds(tx, cards) : cards;
}
export async function readFeedFromHost(query: unknown) {
  return runCommandTransaction(db, async (tx) => {
    const page = await readWorkFeed(tx, query);
    return { ...page, items: await withGuilds(tx, page.items) };
  });
}
/**
 * The same feed for a signed-in person, with their informational eligibility computed here on the server from their
 * current facts. Any failure rejects; the page then falls back to the plain feed.
 */
export async function readFeedForViewerFromHost(
  query: unknown,
  actor: WorkActor,
  eligibleOnly: boolean,
) {
  return runCommandTransaction(db, async (tx) => {
    const evaluate = await createViewerEvaluator(tx, actor, eligibilityTaxonomy());
    const page = await readWorkFeed(tx, query, { evaluate, eligibleOnly });
    return { ...page, items: await withGuilds(tx, page.items) };
  });
}
export async function readDetailFromHost(listingId: unknown) {
  return runCommandTransaction(db, async (tx) => {
    const detail = await readWorkDetail(tx, listingId);
    return (await withGuilds(tx, [detail]))[0];
  });
}
