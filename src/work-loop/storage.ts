import { recordSimulatedReservation } from './reservation-storage';
import { z } from 'zod';
import { InternalId } from '../contracts/ids';
import {
  canonicalRequestDigest,
  executeIdempotentCommand,
  type CommandReceiptTransaction as Tx,
} from '../command-receipts';
import { WorkError, type WorkActor, type WorkCommand, type WorkHost } from './contracts';
import { RaidTermsSchema, publicationProblems, type RaidTerms } from './terms';
const Save = z
  .strictObject({
    listingId: z.uuid().nullable(),
    expectedRevision: z.number().int().min(0).max(2147483646),
    guildId: InternalId,
    terms: RaidTermsSchema,
  })
  .refine((v) => (v.listingId === null ? v.expectedRevision === 0 : v.expectedRevision > 0));
const Publish = z.strictObject({ listingId: z.uuid(), termsVersionId: z.uuid() });
export interface SavedTerms {
  status: 'EXECUTED' | 'REPLAYED';
  listingId: string;
  termsVersionId: string;
  revision: number;
  terms: RaidTerms;
}
function fail(code: WorkError['code']): never {
  throw new WorkError(code);
}
function port(tx: Tx) {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
}
function hostContract(host: WorkHost) {
  if (
    typeof host?.allowNewWrites !== 'boolean' ||
    typeof host.authorize !== 'function' ||
    typeof host.reserveSimulatedFunding !== 'function'
  )
    fail('STORAGE_CONTRACT');
}
async function authorize(tx: Tx, actor: WorkActor, guild: string, host: WorkHost) {
  port(tx);
  hostContract(host);
  if (
    !InternalId.safeParse(actor?.accountId).success ||
    !/^[a-f0-9]{64}$/.test(actor?.sessionHash ?? '')
  )
    fail('FORBIDDEN');
  if ((await host.authorize(tx, actor, guild, 'MANAGE_LISTING')) !== true) fail('FORBIDDEN');
}
interface Listing {
  id: string;
  guildId: string;
  creatorAccountId: string;
  revision: number;
  currentTermsVersionId: string | null;
  state: string;
}
async function listing(
  tx: Tx,
  id: string,
  actor: WorkActor,
  host: WorkHost,
  lock = false,
  missing: 'NOT_FOUND' | 'FORBIDDEN' = 'NOT_FOUND',
) {
  const rows = await tx.query<Listing>(
    `SELECT "id"::text,"guildId","creatorAccountId","revision","currentTermsVersionId"::text,"state" FROM "WorkListing" WHERE "id"=$1::uuid${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (rows.length !== 1) fail(missing);
  await authorize(tx, actor, rows[0].guildId, host);
  // This first slice owns founder-created listings only; delegated administration is a host extension.
  if (rows[0].creatorAccountId !== actor.accountId) fail('FORBIDDEN');
  return rows[0];
}
async function version(tx: Tx, id: string) {
  const rows = await tx.query<{
    id: string;
    listingId: string;
    revision: number;
    snapshot: unknown;
    digest: string;
  }>(
    `SELECT "id"::text,"listingId"::text,"revision","snapshot","digest" FROM "TermsVersion" WHERE "id"=$1::uuid`,
    [id],
  );
  if (rows.length !== 1) fail('NOT_FOUND');
  const row = rows[0],
    parsed = RaidTermsSchema.safeParse(row.snapshot);
  if (!parsed.success || canonicalRequestDigest(parsed.data) !== row.digest)
    fail('STORAGE_CONTRACT');
  return { ...row, terms: parsed.data };
}
export async function readRaidTerms(tx: Tx, actor: WorkActor, id: string, host: WorkHost) {
  port(tx);
  if (!z.uuid().safeParse(id).success) fail('INVALID_INPUT');
  const refs = await tx.query<{ listingId: string }>(
    'SELECT "listingId"::text FROM "TermsVersion" WHERE "id"=$1::uuid',
    [id],
  );
  if (refs.length !== 1) fail('NOT_FOUND');
  const source = await listing(tx, refs[0].listingId, actor, host),
    v = await version(tx, id);
  await authorize(tx, actor, source.guildId, host);
  return { listingId: source.id, termsVersionId: v.id, revision: v.revision, terms: v.terms };
}
export async function saveRaidTerms(
  tx: Tx,
  command: WorkCommand,
  host: WorkHost,
): Promise<SavedTerms> {
  port(tx);
  const parsed = Save.safeParse(command?.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  await authorize(tx, actor, input.guildId, host);
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'SaveRaidTerms',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      let id = input.listingId;
      if (id === null) {
        const [row] = await tx.query<{ id: string }>(
          'INSERT INTO "WorkListing" ("guildId","creatorAccountId") VALUES ($1,$2) RETURNING "id"::text',
          [input.guildId, actor.accountId],
        );
        id = row.id;
      } else {
        const current = await listing(tx, id, actor, host, true);
        if (current.guildId !== input.guildId) fail('FORBIDDEN');
        if (current.revision !== input.expectedRevision) fail('REVISION_CONFLICT');
        const filled = await tx.query<{ id: string }>(
          'SELECT "id"::text FROM "RaidSlot" WHERE "listingId"=$1::uuid AND "state"=\'FILLED\' LIMIT 1',
          [id],
        );
        if (filled.length) fail('TERMS_FROZEN');
      }
      await authorize(tx, actor, input.guildId, host);
      const [v] = await tx.query<{ id: string }>(
        'INSERT INTO "TermsVersion" ("listingId","revision","snapshot","digest") VALUES ($1::uuid,$2::int,$3::jsonb,$4) RETURNING "id"::text',
        [
          id,
          String(input.expectedRevision + 1),
          JSON.stringify(input.terms),
          canonicalRequestDigest(input.terms),
        ],
      );
      await tx.query(
        'UPDATE "RaidSlot" SET "state"=\'CLOSED\' WHERE "listingId"=$1::uuid AND "state"=\'AVAILABLE\' RETURNING "id"',
        [id],
      );
      await tx.query(
        'UPDATE "WorkListing" SET "currentTermsVersionId"=$2::uuid,"revision"=$3::int,"state"=\'DRAFT\' WHERE "id"=$1::uuid RETURNING "id"',
        [id, v.id, String(input.expectedRevision + 1)],
      );
      return {
        resultRef: v.id,
        events: [
          {
            type: 'work.terms_saved.v1',
            aggregateId: id,
            aggregateVersion: input.expectedRevision + 1,
            guildId: input.guildId,
            payload: { termsVersionId: v.id },
          },
        ],
      };
    },
  );
  const saved = await readRaidTerms(tx, actor, result.resultRef, host);
  return { status: result.status, ...saved };
}
export async function publishRaid(tx: Tx, command: WorkCommand, host: WorkHost) {
  port(tx);
  const parsed = Publish.safeParse(command?.input);
  if (!parsed.success) fail('INVALID_INPUT');
  const input = parsed.data,
    actor = command.actor;
  await listing(tx, input.listingId, actor, host, false, 'FORBIDDEN');
  const result = await executeIdempotentCommand(
    tx,
    {
      actorId: actor.accountId,
      commandKind: 'PublishRaid',
      idempotencyKey: command.idempotencyKey,
      requestId: command.requestId,
      request: input,
    },
    async () => {
      if (!host.allowNewWrites) fail('WRITES_DISABLED');
      const source = await listing(tx, input.listingId, actor, host, true, 'FORBIDDEN');
      if (source.currentTermsVersionId !== input.termsVersionId) fail('REVISION_CONFLICT');
      if (!['DRAFT', 'OPEN'].includes(source.state)) fail('PUBLICATION_BLOCKED');
      const v = await version(tx, input.termsVersionId);
      const [clock] = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now', []);
      if (!(clock?.now instanceof Date) || publicationProblems(v.terms, clock.now).length)
        fail('PUBLICATION_BLOCKED');
      const prior = await tx.query<{ id: string; state: string }>(
        `SELECT "id"::text,"state" FROM "RaidSlot" WHERE "listingId"=$1::uuid AND "termsVersionId"=$2::uuid AND "slotNumber"=1`,
        [source.id, v.id],
      );
      if (source.state === 'OPEN' && prior[0]?.state !== 'AVAILABLE') fail('PUBLICATION_BLOCKED');
      let slotId = prior[0]?.id;
      if (!slotId) {
        const [slot] = await tx.query<{ id: string }>(
          'INSERT INTO "RaidSlot" ("listingId","termsVersionId","slotNumber") VALUES ($1::uuid,$2::uuid,1) RETURNING "id"::text',
          [source.id, v.id],
        );
        slotId = slot.id;
        const funding = await host.reserveSimulatedFunding(tx, {
          slotId,
          termsVersionId: v.id,
          terms: v.terms,
        });
        if (!InternalId.safeParse(funding).success) fail('FUNDING_REQUIRED');
        await recordSimulatedReservation(
          tx,
          { slotId, termsVersionId: v.id, terms: v.terms },
          funding as string,
        );
        await tx.query('UPDATE "RaidSlot" SET "fundingRef"=$2 WHERE "id"=$1::uuid RETURNING "id"', [
          slotId,
          funding,
        ]);
      }
      await authorize(tx, actor, source.guildId, host);
      await tx.query(
        'UPDATE "WorkListing" SET "state"=\'OPEN\' WHERE "id"=$1::uuid RETURNING "id"',
        [source.id],
      );
      return {
        resultRef: slotId,
        events: [
          {
            type: 'work.raid_published.v1',
            aggregateId: source.id,
            aggregateVersion: source.revision,
            guildId: source.guildId,
            payload: { termsVersionId: v.id, raidSlotId: slotId },
          },
        ],
      };
    },
  );
  const source = await listing(tx, input.listingId, actor, host, false, 'FORBIDDEN');
  const slots = await tx.query<{ id: string; termsVersionId: string }>(
    'SELECT "id"::text,"termsVersionId"::text FROM "RaidSlot" WHERE "id"=$1::uuid AND "listingId"=$2::uuid',
    [result.resultRef, source.id],
  );
  if (slots.length !== 1 || slots[0].termsVersionId !== input.termsVersionId)
    fail('STORAGE_CONTRACT');
  return {
    status: result.status,
    listingId: source.id,
    termsVersionId: input.termsVersionId,
    slotId: result.resultRef,
    fundingMode: 'SIMULATED' as const,
  };
}
