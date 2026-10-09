export type SqlBinding = string | null;
/**
 * Stable v1 port. The host owns the connection and one interactive transaction; the module owns its SQL.
 * Only PostgreSQL at READ COMMITTED is supported. Anything else must fail closed (STORAGE_CONTRACT).
 */
export interface CommandReceiptTransaction {
  readonly dialect: 'POSTGRESQL';
  readonly isolation: 'READ_COMMITTED';
  query<Row>(sql: string, bindings: readonly SqlBinding[]): Promise<Row[]>;
}
export type CommandReceiptCode =
  | 'INVALID_INPUT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'DELIVERY_PAYLOAD_CONFLICT'
  | 'STORAGE_CONTRACT'
  | 'RETRY_TRANSACTION'
  | 'STORAGE_UNAVAILABLE';
export class CommandReceiptError extends Error {
  constructor(readonly code: CommandReceiptCode) {
    super(code);
    this.name = 'CommandReceiptError';
  }
}
/** Everything that defines the command goes in `request`, including any expected terms/revision. */
export interface CommandInput {
  actorId: string;
  commandKind: string;
  idempotencyKey: string;
  requestId: string;
  request: unknown;
}
export interface DomainEventInput {
  type: string;
  aggregateId: string;
  aggregateVersion: number;
  guildId?: string | null;
  /** Identifier-only payload as defined by the shared EventEnvelope contract. */
  payload?: Readonly<Record<string, string>>;
  /** Default true: also record an outbox intent. */
  publish?: boolean;
}
export interface CommandOutcome {
  /** Opaque reference to the business result (never the result itself). */
  resultRef: string;
  events: readonly DomainEventInput[];
}
export interface CommandHandlerContext {
  readonly receiptId: string;
}
export type CommandHandler = (context: CommandHandlerContext) => Promise<CommandOutcome>;
export interface InboundDeliveryHandlerContext {
  readonly deliveryRecordId: string;
}
export type InboundDeliveryHandler = (
  context: InboundDeliveryHandlerContext,
) => Promise<CommandOutcome>;
export interface CommandResult {
  status: 'EXECUTED' | 'REPLAYED';
  receiptId: string;
  resultRef: string;
}
export interface InboundDeliveryInput {
  provider: string;
  /** Delivery id already authenticated by the host's provider-specific verification. */
  verifiedDeliveryId: string;
  payload: unknown;
}
export interface InboundDeliveryResult {
  status: 'PROCESSED' | 'DUPLICATE';
  deliveryRecordId: string;
  resultRef: string;
}
export interface RetryOptions {
  maxAttempts?: number;
  isRetryable?: (error: unknown) => boolean;
}
