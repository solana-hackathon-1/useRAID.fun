import { EventEnvelopeSchema } from '../contracts/protocol';
import { InternalId } from '../contracts/ids';
import { canonicalRequestDigest } from './canonical';
import {
  CommandReceiptError,
  type CommandHandler,
  type CommandInput,
  type CommandOutcome,
  type CommandReceiptTransaction,
  type CommandResult,
  type InboundDeliveryHandler,
  type InboundDeliveryInput,
  type InboundDeliveryResult,
  type RetryOptions,
  type SqlBinding,
} from './contracts';
export { CommandReceiptError } from './contracts';
export type * from './contracts';
export { canonicalRequestDigest } from './canonical';

const COMMAND_KIND = /^[A-Z][A-Za-z0-9]{2,63}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{1,63}$/;
const MAX_EVENTS = 20;
const MAX_DELIVERY_ID = 120;
const DEFAULT_ATTEMPTS = 3;
const MAX_ATTEMPTS = 10;
// Placeholders only satisfy the shared envelope schema; the database assigns the real id and time.
const PENDING_EVENT_ID = 'pending';
const PENDING_OCCURRED_AT = '1970-01-01T00:00:00.000Z';

function fail(code: ConstructorParameters<typeof CommandReceiptError>[0]): never {
  throw new CommandReceiptError(code);
}
function validId(value: unknown, maxLength = 200): asserts value is string {
  if (!InternalId.safeParse(value).success || (value as string).length > maxLength)
    fail('INVALID_INPUT');
}
function validPort(tx: CommandReceiptTransaction) {
  if (
    tx?.dialect !== 'POSTGRESQL' ||
    tx?.isolation !== 'READ_COMMITTED' ||
    typeof tx.query !== 'function'
  )
    fail('STORAGE_CONTRACT');
}
async function query(
  tx: CommandReceiptTransaction,
  sql: string,
  bindings: readonly SqlBinding[],
): Promise<unknown[]> {
  try {
    const rows = await tx.query<unknown>(sql, bindings);
    if (!Array.isArray(rows)) fail('STORAGE_CONTRACT');
    return rows;
  } catch (error) {
    if (error instanceof CommandReceiptError) throw error;
    // Unknown driver detail is never exposed; the host port classifies retryable failures itself.
    return fail('STORAGE_UNAVAILABLE');
  }
}
function oneId(rows: unknown[]): string {
  const id = (rows[0] as { id?: unknown } | undefined)?.id;
  if (rows.length !== 1 || typeof id !== 'string' || !id) fail('STORAGE_CONTRACT');
  return id;
}
interface StoredClaim {
  id: string;
  digest: string;
  resultRef: string;
}
function storedClaim(rows: unknown[], digestKey: string): StoredClaim {
  const row = rows[0] as Record<string, unknown> | undefined;
  const digest = row?.[digestKey];
  if (
    rows.length !== 1 ||
    typeof row?.id !== 'string' ||
    typeof digest !== 'string' ||
    typeof row.resultRef !== 'string' ||
    !row.resultRef
  )
    fail('STORAGE_CONTRACT');
  return { id: row.id, digest, resultRef: row.resultRef };
}
interface ParsedEvent {
  type: string;
  aggregateId: string;
  aggregateVersion: number;
  guildId: string | null;
  payload: string;
  publish: boolean;
}
function parseOutcome(
  outcome: unknown,
  actorId: string,
  correlationId: string,
): { resultRef: string; events: ParsedEvent[] } {
  const candidate = outcome as Partial<CommandOutcome> | undefined;
  validId(candidate?.resultRef);
  const events = candidate.events;
  if (!Array.isArray(events) || events.length < 1 || events.length > MAX_EVENTS)
    fail('INVALID_INPUT');
  return {
    resultRef: candidate.resultRef,
    events: events.map((event) => {
      if (event?.publish !== undefined && typeof event.publish !== 'boolean') fail('INVALID_INPUT');
      const parsed = EventEnvelopeSchema.safeParse({
        eventId: PENDING_EVENT_ID,
        type: event?.type,
        aggregateId: event?.aggregateId,
        aggregateVersion: event?.aggregateVersion,
        occurredAt: PENDING_OCCURRED_AT,
        actorId,
        guildId: event?.guildId ?? null,
        correlationId,
        payload: event?.payload ?? {},
      });
      if (!parsed.success) fail('INVALID_INPUT');
      return {
        type: parsed.data.type,
        aggregateId: parsed.data.aggregateId,
        aggregateVersion: parsed.data.aggregateVersion,
        guildId: parsed.data.guildId,
        payload: JSON.stringify(parsed.data.payload),
        publish: event.publish !== false,
      };
    }),
  };
}
type Claim = { table: 'CommandReceipt' | 'InboxDelivery'; id: string };
async function record(
  tx: CommandReceiptTransaction,
  claim: Claim,
  actorId: string,
  correlationId: string,
  outcome: unknown,
): Promise<string> {
  // Validate everything before the first write so a bad outcome leaves no partial rows.
  const { resultRef, events } = parseOutcome(outcome, actorId, correlationId);
  const [receiptId, inboxId] =
    claim.table === 'CommandReceipt' ? [claim.id, null] : [null, claim.id];
  for (const [ordinal, event] of events.entries()) {
    const eventId = oneId(
      await query(
        tx,
        `INSERT INTO "AuditEvent" ("receiptId", "inboxId", "ordinal", "eventType", "aggregateId", "aggregateVersion", "actorId", "guildId", "correlationId", "payload")
         VALUES ($1::uuid, $2::uuid, $3::int, $4, $5, $6::int, $7, $8, $9, $10::jsonb) RETURNING "id"::text AS "id"`,
        [
          receiptId,
          inboxId,
          String(ordinal),
          event.type,
          event.aggregateId,
          String(event.aggregateVersion),
          actorId,
          event.guildId,
          correlationId,
          event.payload,
        ],
      ),
    );
    if (event.publish)
      await query(tx, 'INSERT INTO "OutboxEvent" ("eventId") VALUES ($1::uuid)', [eventId]);
  }
  oneId(
    await query(
      tx,
      `UPDATE "${claim.table}" SET "resultRef" = $2 WHERE "id" = $1::uuid AND "resultRef" IS NULL RETURNING "id"::text AS "id"`,
      [claim.id, resultRef],
    ),
  );
  return resultRef;
}
interface ClaimSpec {
  insertSql: string;
  insertBindings: readonly SqlBinding[];
  lookupSql: string;
  lookupBindings: readonly SqlBinding[];
  digestColumn: 'requestDigest' | 'payloadDigest';
  digest: string;
  conflict: 'IDEMPOTENCY_KEY_REUSED' | 'DELIVERY_PAYLOAD_CONFLICT';
}
/** Race-safe claim: the unique index serializes duplicates; a loser replays or conflicts after the winner ends. */
async function claimOrReplay(
  tx: CommandReceiptTransaction,
  spec: ClaimSpec,
): Promise<{ claimedId: string } | { stored: StoredClaim }> {
  const claimed = await query(tx, spec.insertSql, spec.insertBindings);
  if (claimed.length > 0) return { claimedId: oneId(claimed) };
  const stored = storedClaim(
    await query(tx, spec.lookupSql, spec.lookupBindings),
    spec.digestColumn,
  );
  if (stored.digest !== spec.digest) fail(spec.conflict);
  return { stored };
}
/**
 * Claims the (actor, kind, key) receipt, runs the caller's state change, then records audit events,
 * outbox intents and the result reference in the SAME transaction. Same key and digest replays the
 * stored result without running `handler`; same key and another digest throws IDEMPOTENCY_KEY_REUSED.
 * Handler errors propagate unchanged and the host's rollback leaves no receipt.
 */
export async function executeIdempotentCommand(
  tx: CommandReceiptTransaction,
  command: CommandInput,
  handler: CommandHandler,
): Promise<CommandResult> {
  validId(command?.actorId);
  validId(command.idempotencyKey);
  validId(command.requestId);
  if (typeof command.commandKind !== 'string' || !COMMAND_KIND.test(command.commandKind))
    fail('INVALID_INPUT');
  const digest = canonicalRequestDigest(command.request);
  validPort(tx);
  const claim = await claimOrReplay(tx, {
    insertSql: `INSERT INTO "CommandReceipt" ("actorId", "commandKind", "idempotencyKey", "requestDigest", "requestId")
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ("actorId", "commandKind", "idempotencyKey") DO NOTHING RETURNING "id"::text AS "id"`,
    insertBindings: [
      command.actorId,
      command.commandKind,
      command.idempotencyKey,
      digest,
      command.requestId,
    ],
    lookupSql: `SELECT "id"::text AS "id", "requestDigest", "resultRef" FROM "CommandReceipt"
         WHERE "actorId" = $1 AND "commandKind" = $2 AND "idempotencyKey" = $3`,
    lookupBindings: [command.actorId, command.commandKind, command.idempotencyKey],
    digestColumn: 'requestDigest',
    digest,
    conflict: 'IDEMPOTENCY_KEY_REUSED',
  });
  if ('stored' in claim)
    return { status: 'REPLAYED', receiptId: claim.stored.id, resultRef: claim.stored.resultRef };
  const receiptId = claim.claimedId;
  const outcome = await handler({ receiptId });
  const resultRef = await record(
    tx,
    { table: 'CommandReceipt', id: receiptId },
    command.actorId,
    command.requestId,
    outcome,
  );
  return { status: 'EXECUTED', receiptId, resultRef };
}
/**
 * Deduplicates an authenticated provider delivery by (provider, verifiedDeliveryId). Only a digest of
 * the payload is stored. The host must verify the delivery's authenticity before calling.
 */
export async function processInboundDelivery(
  tx: CommandReceiptTransaction,
  delivery: InboundDeliveryInput,
  handler: InboundDeliveryHandler,
): Promise<InboundDeliveryResult> {
  if (typeof delivery?.provider !== 'string' || !PROVIDER.test(delivery.provider))
    fail('INVALID_INPUT');
  validId(delivery.verifiedDeliveryId, MAX_DELIVERY_ID);
  const digest = canonicalRequestDigest(delivery.payload);
  validPort(tx);
  const claim = await claimOrReplay(tx, {
    insertSql: `INSERT INTO "InboxDelivery" ("provider", "deliveryId", "payloadDigest") VALUES ($1, $2, $3)
     ON CONFLICT ("provider", "deliveryId") DO NOTHING RETURNING "id"::text AS "id"`,
    insertBindings: [delivery.provider, delivery.verifiedDeliveryId, digest],
    lookupSql: `SELECT "id"::text AS "id", "payloadDigest", "resultRef" FROM "InboxDelivery"
         WHERE "provider" = $1 AND "deliveryId" = $2`,
    lookupBindings: [delivery.provider, delivery.verifiedDeliveryId],
    digestColumn: 'payloadDigest',
    digest,
    conflict: 'DELIVERY_PAYLOAD_CONFLICT',
  });
  if ('stored' in claim)
    return {
      status: 'DUPLICATE',
      deliveryRecordId: claim.stored.id,
      resultRef: claim.stored.resultRef,
    };
  const deliveryRecordId = claim.claimedId;
  const outcome = await handler({ deliveryRecordId });
  const resultRef = await record(
    tx,
    { table: 'InboxDelivery', id: deliveryRecordId },
    `provider:${delivery.provider}`,
    `delivery:${delivery.provider}:${delivery.verifiedDeliveryId}`,
    outcome,
  );
  return { status: 'PROCESSED', deliveryRecordId, resultRef };
}
/**
 * Re-runs the WHOLE attempt (open transaction, claim, callback, commit) when it fails with a retryable
 * error. The caller supplies the same command identity each time, so retries cannot mint a new outcome.
 */
export async function retryWholeTransaction<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS)
    fail('INVALID_INPUT');
  const isRetryable =
    options.isRetryable ??
    ((error: unknown) =>
      error instanceof CommandReceiptError && error.code === 'RETRY_TRANSACTION');
  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      return await attempt(attemptNumber);
    } catch (error) {
      if (attemptNumber >= maxAttempts || !isRetryable(error)) throw error;
    }
  }
}
