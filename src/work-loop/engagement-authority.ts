import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import { canonicalRequestDigest, type CommandReceiptTransaction as Tx } from '../command-receipts';
import {
  prepareModuleIdentity,
  requireIdentityLocks,
  type IdentityLockCapability,
} from '../identity-locks';
import { WorkError, type WorkActor } from './contracts';
import { RaidTermsSchema, publicationProblems } from './terms';
export function fail(code: WorkError['code']): never {
  throw new WorkError(code);
}
/** A passed commitment deadline is its own answer; any other publication problem means the Raid is not takeable. */
export function assertOpenForTaking(terms: unknown, now: Date) {
  const problems = publicationProblems(terms, now);
  if (problems.length)
    fail(problems.includes('DEADLINE_PASSED') ? 'DEADLINE_PASSED' : 'PUBLICATION_BLOCKED');
}
export function validate(tx: Tx, actor: WorkActor) {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
  if (
    !InternalId.safeParse(actor?.accountId).success ||
    !/^[a-f0-9]{64}$/.test(actor?.sessionHash ?? '')
  )
    fail('UNAUTHENTICATED');
}
/** Cheap preliminary check only. Final authority is rechecked after all identity lock waits. */
export async function session(tx: Tx, actor: WorkActor) {
  const rows = await tx.query<{ suspended: boolean }>(
    `SELECT u."suspended" FROM "User" u JOIN "Session" s ON s."userId"=u."id" WHERE u."id"=$1 AND s."tokenHash"=$2 AND s."via" IN ('wallet','x') AND s."expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')`,
    [actor.accountId, actor.sessionHash],
  );
  if (rows.length !== 1) fail('UNAUTHENTICATED');
  if (rows[0].suspended) fail('ACCOUNT_RESTRICTED');
}
export async function currentActor(tx: Tx, actor: WorkActor, prelocked?: IdentityLockCapability) {
  const locks = prelocked ?? (await prepareModuleIdentity(tx, actor.accountId, 'SHARE'));
  await requireIdentityLocks(tx, locks, {
    accounts: [{ id: actor.accountId, mode: 'SHARE' }],
    children: ['Session', 'Participant'],
  });
  await session(tx, actor);
  return locks;
}
export async function currentHuman(tx: Tx, actor: WorkActor, prelocked?: IdentityLockCapability) {
  const locks = await currentActor(tx, actor, prelocked);
  const rows = await tx.query<{ id: string; kind: string }>(
    'SELECT "id"::text,"kind" FROM "Participant" WHERE "accountId"=$1',
    [actor.accountId],
  );
  if (rows.length !== 1 || rows[0].kind !== 'HUMAN' || !z.uuid().safeParse(rows[0].id).success)
    fail('FORBIDDEN');
  return { participantId: rows[0].id, locks };
}
export interface Source {
  listingId: string;
  guildId: string;
  revision: number;
  listingState: string;
  currentTermsVersionId: string;
  state: string;
  fundingMode: string;
  fundingRef: string | null;
  termsVersionId: string;
}
export async function source(tx: Tx, slotId: string) {
  const refs = await tx.query<{ listingId: string }>(
    'SELECT "listingId"::text FROM "RaidSlot" WHERE "id"=$1::uuid',
    [slotId],
  );
  if (refs.length !== 1) fail('NOT_FOUND');
  // Every source writer uses listing before slot; terms history is immutable.
  await tx.query('SELECT "id" FROM "WorkListing" WHERE "id"=$1::uuid FOR UPDATE', [
    refs[0].listingId,
  ]);
  await tx.query('SELECT "id" FROM "RaidSlot" WHERE "id"=$1::uuid FOR UPDATE', [slotId]);
  const rows = await tx.query<Source>(
    `SELECT l."id"::text AS "listingId",l."guildId",l."revision",l."state" AS "listingState",l."currentTermsVersionId"::text,s."state",s."fundingMode",s."fundingRef",s."termsVersionId"::text FROM "RaidSlot" s JOIN "WorkListing" l ON l."id"=s."listingId" WHERE s."id"=$1::uuid`,
    [slotId],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  return rows[0];
}
export async function definition(tx: Tx, id: string) {
  const rows = await tx.query<{ snapshot: unknown; digest: string }>(
    'SELECT "snapshot","digest" FROM "TermsVersion" WHERE "id"=$1::uuid',
    [id],
  );
  const parsed = RaidTermsSchema.safeParse(rows[0]?.snapshot);
  if (
    rows.length !== 1 ||
    !parsed.success ||
    canonicalRequestDigest(parsed.data) !== rows[0].digest
  )
    fail('STORAGE_CONTRACT');
  return parsed.data;
}
export async function clock(tx: Tx) {
  const [row] = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now', []);
  if (!(row?.now instanceof Date)) fail('STORAGE_CONTRACT');
  return row.now;
}
