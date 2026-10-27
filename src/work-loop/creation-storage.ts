import { canonicalRequestDigest, type CommandReceiptTransaction as Tx } from '../command-receipts';
import type { WorkActor, WorkHost } from './contracts';
import { RaidTermsSchema, publicationProblems } from './terms';
import { CreationDraftSchema, type CreationDraft } from './creation-contracts';
import { fail, validate, currentActor } from './engagement-authority';

const LIMIT = 20;
/** The Founder's own listings (latest first) with their current terms; hidden when the host denies Guild authority. */
export async function readCreationDrafts(
  tx: Tx,
  actor: WorkActor,
  host: Pick<WorkHost, 'authorize'>,
  exact?: { listingId: string; termsVersionId: string },
): Promise<CreationDraft[]> {
  validate(tx, actor);
  if (typeof host?.authorize !== 'function') fail('STORAGE_CONTRACT');
  const locks = await currentActor(tx, actor);
  const rows = await tx.query<{
    listingId: string;
    guildId: string;
    revision: number;
    state: string;
    termsVersionId: string;
    snapshot: unknown;
    digest: string;
    reserved: boolean;
    current: boolean;
    now: Date;
  }>(
    `SELECT l."id"::text AS "listingId",l."guildId",t."revision",l."state",t."id"::text AS "termsVersionId",t."snapshot",t."digest",
      EXISTS (SELECT 1 FROM "RaidSlot" s WHERE s."listingId"=l."id" AND s."termsVersionId"=t."id" AND s."fundingRef" IS NOT NULL) AS reserved,
      l."currentTermsVersionId"=t."id" AS current, clock_timestamp() AS now
     FROM "WorkListing" l JOIN "TermsVersion" t ON ${exact ? 't."listingId"=l."id" AND t."id"=$3::uuid' : 't."id"=l."currentTermsVersionId"'}
     WHERE l."creatorAccountId"=$1 ${exact ? 'AND l."id"=$2::uuid' : ''} ORDER BY l."createdAt" DESC LIMIT ${LIMIT}`,
    exact ? [actor.accountId, exact.listingId, exact.termsVersionId] : [actor.accountId],
  );
  const drafts: CreationDraft[] = [];
  for (const row of rows) {
    if ((await host.authorize(tx, actor, row.guildId, 'MANAGE_LISTING')) !== true) continue;
    const terms = RaidTermsSchema.safeParse(row.snapshot);
    if (!terms.success || canonicalRequestDigest(terms.data) !== row.digest)
      fail('STORAGE_CONTRACT');
    drafts.push(
      CreationDraftSchema.parse({
        listingId: row.listingId,
        termsVersionId: row.termsVersionId,
        revision: row.revision,
        state: row.state,
        terms: terms.data,
        problems: [
          ...publicationProblems(terms.data, row.now),
          ...(row.current ? [] : ['TERMS_VERSION_CHANGED']),
        ],
        reserved: row.reserved,
      }),
    );
  }
  await currentActor(tx, actor, locks);
  return drafts;
}
