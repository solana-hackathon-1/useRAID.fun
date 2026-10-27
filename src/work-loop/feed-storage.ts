import type { CommandReceiptTransaction as Tx } from '../command-receipts';
import { assetKey } from '../contracts/assets';
import { fromJsonAmount } from '../asset-registry/amounts';
import { WorkError } from './contracts';
import { RaidTermsSchema, type RaidTerms } from './terms';
import {
  FeedCardSchema,
  FeedPageSchema,
  FeedQuerySchema,
  type FeedCard,
  type FeedPage,
  type FeedQuery,
} from './feed-contracts';

/** Candidate rows read per request. The feed is a bounded window of the newest live work, never an unbounded scan. */
const WINDOW = 500;
const fail = (code: WorkError['code']): never => {
  throw new WorkError(code);
};
interface Row {
  listingId: string;
  guildId: string;
  termsVersionId: string;
  snapshot: unknown;
  createdMicros: string;
  availableSlots: number;
}
interface Candidate {
  card: FeedCard;
  terms: RaidTerms;
  key: bigint;
}
interface Cursor {
  s: FeedQuery['sort'];
  a: string | null;
  k: string;
  i: string;
}
function encode(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
function decode(raw: string, query: FeedQuery): Cursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (
      value?.s !== query.sort ||
      (value.a ?? null) !== (query.assetKey ?? null) ||
      !/^\d{1,40}$/.test(String(value.k)) ||
      !/^[0-9a-f-]{36}$/.test(String(value.i))
    )
      return fail('INVALID_INPUT');
    return value;
  } catch {
    return fail('INVALID_INPUT');
  }
}
/** Newest and reward order descending; the nearest deadline comes first. Ties fall back to the listing id. */
const ascending = (sort: FeedQuery['sort']) => sort === 'deadline';
function before(a: Candidate, b: { key: bigint; id: string }, sort: FeedQuery['sort']) {
  if (a.key !== b.key) return ascending(sort) ? a.key < b.key : a.key > b.key;
  return a.card.listingId < b.id;
}
/** Strictly after the cursor position in the same total order. */
function follows(a: Candidate, position: { key: bigint; id: string }, sort: FeedQuery['sort']) {
  return a.key === position.key && a.card.listingId === position.id
    ? false
    : !before(a, position, sort);
}
function candidate(row: Row, query: FeedQuery): Candidate | null {
  const parsed = RaidTermsSchema.safeParse(row.snapshot);
  // A corrupt stored version is never exposed and never takes the public feed down.
  if (!parsed.success || parsed.data.visibility !== 'PUBLIC') return null;
  const terms = parsed.data;
  const rewards = terms.rewards.map((leg) => ({
    assetKey: assetKey(leg.policy.assetId),
    assetId: leg.policy.assetId,
    decimals: leg.policy.verifiedDecimals,
    amount: leg.amount,
  }));
  if (query.category && terms.category !== query.category) return null;
  if (query.skillId && !terms.requiredSkills.some((s) => s.skillId === query.skillId)) return null;
  if (query.difficulty && terms.difficulty !== query.difficulty) return null;
  if (query.participantKind && !terms.participantKinds.includes(query.participantKind)) return null;
  if (query.execution && terms.execution !== query.execution) return null;
  if (query.admission && terms.admission !== query.admission) return null;
  if (query.assetKey && !rewards.some((r) => r.assetKey === query.assetKey)) return null;
  if (
    query.closesBefore &&
    Date.parse(terms.deadlines.commitment) >= Date.parse(query.closesBefore)
  )
    return null;
  const card = FeedCardSchema.safeParse({
    listingId: row.listingId,
    termsVersionId: row.termsVersionId,
    guildId: row.guildId,
    title: terms.title,
    publicSummary: terms.publicSummary,
    category: terms.category,
    difficulty: terms.difficulty,
    requiredSkills: terms.requiredSkills.map((s) => ({
      skillId: s.skillId,
      minimumRank: s.minimumRank,
    })),
    participantKinds: terms.participantKinds,
    execution: terms.execution,
    admission: terms.admission,
    rewards,
    commitmentDeadline: terms.deadlines.commitment,
    submissionDeadline: terms.deadlines.submission,
    availableSlots: row.availableSlots,
    funding: { mode: 'SIMULATED' },
    confidentiality: 'PUBLIC',
  });
  if (!card.success) return null;
  const key =
    query.sort === 'newest'
      ? BigInt(row.createdMicros)
      : query.sort === 'deadline'
        ? BigInt(Date.parse(terms.deadlines.commitment))
        : rewards
            .filter((r) => r.assetKey === query.assetKey)
            .reduce((sum, r) => sum + fromJsonAmount(r.amount), 0n);
  return { card: card.data, terms, key };
}
/**
 * Public, read-only Raid feed (blueprint §18.1–18.2). Lists open, publicly visible work with a currently funded
 * (simulated) available slot and an unexpired commitment window. It takes no actor, grants no permission and
 * decides nothing about the viewer's eligibility: that is rechecked by the server at the action.
 */
export async function readWorkFeed(tx: Tx, input: unknown): Promise<FeedPage> {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  const parsed = FeedQuerySchema.safeParse(input ?? {});
  if (!parsed.success) return fail('INVALID_INPUT');
  const query = parsed.data;
  const cursor = query.cursor ? decode(query.cursor, query) : null;
  const rows = await tx.query<Row>(
    `SELECT l."id"::text AS "listingId",l."guildId",t."id"::text AS "termsVersionId",t."snapshot",
      (extract(epoch FROM l."createdAt")*1000000)::bigint::text AS "createdMicros",
      (SELECT count(*)::int FROM "RaidSlot" s WHERE s."listingId"=l."id" AND s."termsVersionId"=t."id" AND s."state"='AVAILABLE' AND s."fundingMode"='SIMULATED' AND s."fundingRef" IS NOT NULL) AS "availableSlots"
     FROM "WorkListing" l JOIN "TermsVersion" t ON t."id"=l."currentTermsVersionId"
     WHERE l."state"='OPEN' AND t."snapshot"->>'visibility'='PUBLIC'
      AND (t."snapshot"->'deadlines'->>'commitment')::timestamptz>clock_timestamp()
     ORDER BY l."createdAt" DESC,l."id" DESC LIMIT ${WINDOW}`,
    [],
  );
  const live = rows
    .filter((row) => row.availableSlots >= 1)
    .map((row) => candidate(row, query))
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => (before(a, { key: b.key, id: b.card.listingId }, query.sort) ? -1 : 1));
  const after = cursor
    ? live.filter((c) => follows(c, { key: BigInt(cursor.k), id: cursor.i }, query.sort))
    : live;
  const window = after.slice(0, query.limit + 1);
  const items = window.slice(0, query.limit);
  const last = items[items.length - 1];
  return FeedPageSchema.parse({
    items: items.map((c) => c.card),
    nextCursor:
      window.length > query.limit && last
        ? encode({
            s: query.sort,
            a: query.assetKey ?? null,
            k: last.key.toString(),
            i: last.card.listingId,
          })
        : null,
    sort: query.sort,
    rewardComparable: query.assetKey !== undefined,
  });
}
