import {
  readFeedAssets,
  readFeedFacets,
  readWorkDetail,
  readWorkFeed,
} from '../work-loop/feed-storage';
import { attachPublicGuilds } from './work-feed-guilds';
import { WorkError, type WorkActor } from '../work-loop/contracts';
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
/**
 * Exact-string flag, default off: the minimum-reward filter (one asset, base units). While off, a request that names
 * `minReward` is refused as invalid input rather than silently ignored; every other query is unchanged.
 */
export function workFeedRewardFilterAvailable() {
  return process.env.WORK_FEED_REWARD_FILTER_ENABLED === 'true';
}
function guardRewardFilter(query: unknown) {
  if (
    typeof query === 'object' &&
    query !== null &&
    (query as { minReward?: unknown }).minReward !== undefined &&
    !workFeedRewardFilterAvailable()
  )
    throw new WorkError('INVALID_INPUT');
}
/** Guild names and links appear only while public Guild reads are on, exactly as the Guild page itself. */
async function withGuilds<T extends { guildId: string }>(
  tx: Parameters<typeof attachPublicGuilds>[0],
  cards: T[],
) {
  return guildPublicAvailable() ? attachPublicGuilds(tx, cards) : cards;
}
/** The live reward assets and their decimals for the display-unit minimum; closed while the reward filter is off. */
export async function readFeedAssetsFromHost() {
  if (!workFeedRewardFilterAvailable()) throw new WorkError('INVALID_INPUT');
  return runCommandTransaction(db, (tx) => readFeedAssets(tx));
}
/** Suggestions for the category and skill filters: the same public live work the feed lists, nothing more. */
export async function readFeedFacetsFromHost() {
  return runCommandTransaction(db, (tx) => readFeedFacets(tx));
}
export async function readFeedFromHost(query: unknown) {
  guardRewardFilter(query);
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
  guardRewardFilter(query);
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
