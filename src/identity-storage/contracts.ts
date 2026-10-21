import type { Participant } from '../contracts/entities';
export type HumanParticipant = Extract<Participant, { kind: 'HUMAN' }>;
export interface IdentityTransaction {
  readonly dialect: 'POSTGRESQL';
  readonly isolation: 'READ_COMMITTED';
  readonly identityLayout?: import('../identity-locks').LockTransaction['identityLayout'];
  query<Row>(sql: string, bindings: readonly string[]): Promise<Row[]>;
}
export type IdentityStorageCode =
  | 'INVALID_INPUT'
  | 'WRONG_ACTOR'
  | 'ACCOUNT_NOT_FOUND'
  | 'STORAGE_CONTRACT'
  | 'RETRY_TRANSACTION'
  | 'UNIQUE_CONFLICT'
  | 'STORAGE_UNAVAILABLE';
export class IdentityStorageError extends Error {
  constructor(readonly code: IdentityStorageCode) {
    super(code);
    this.name = 'IdentityStorageError';
  }
}
export interface ProvisionHumanInput {
  locks?: import('../identity-locks').IdentityLockCapability;
  accountId: string;
  actorAccountId: string;
  requestId: string;
}
