export type { IdentityTransaction } from '../identity-storage';

export const IDENTITY_LINK_VERSION = 'v1' as const;
export type IdentityLinkCode =
  | 'INVALID_INPUT'
  | 'WRONG_ACTOR'
  | 'ACCOUNT_NOT_FOUND'
  | 'AUTHENTICATION_REQUIRED'
  | 'FORBIDDEN'
  | 'ACCOUNT_RESTRICTED'
  | 'PROOF_INVALID'
  | 'UNSUPPORTED_IDENTITY'
  | 'IDENTITY_CONFLICT'
  | 'IDENTITY_REVOKED'
  | 'PRIMARY_WALLET_REQUIRED'
  | 'LINK_LIMIT_REACHED'
  | 'STORAGE_CONTRACT'
  | 'RETRY_TRANSACTION'
  | 'STORAGE_UNAVAILABLE';
/** The message is the code only: never an address, proof, owner, constraint or driver text. */
export class IdentityLinkError extends Error {
  constructor(readonly code: IdentityLinkCode) {
    super(code);
    this.name = 'IdentityLinkError';
  }
}
export interface WalletLinkLimits {
  /** Most ACTIVE additional links one account may hold (EXAMPLE 5, injected, not a decision). */
  maxActiveLinks: number;
  /** Most link rows (ACTIVE plus REVOKED) one account may ever hold (EXAMPLE 20). */
  maxTotalLinks: number;
}
export interface LinkWalletInput {
  accountId: string;
  /** Verified caller, supplied by the trusted host. Must equal `accountId`. */
  actorAccountId: string;
  requestId: string;
  subject: { networkIdentity: string; address: string };
  /** Host-built `LinkProofObservation` (see `src/identity`): the challenge as atomically claimed. */
  proof: unknown;
  /** Host-built session observation: `{ accountId, state, expiresAt }`. */
  session: unknown;
  /** Host `IdentityLinkPolicy`: domain, uri, supported wallet networks. */
  policy: unknown;
  /** Host clock (UTC ISO). The module never reads the system clock. */
  now: unknown;
  limits: WalletLinkLimits;
}
export type LinkWalletResult = Readonly<{
  outcome: 'LINKED' | 'ALREADY_LINKED';
  /** `PRIMARY` when the address is the account's own payout-bound legacy wallet. */
  source: 'LINK' | 'PRIMARY';
  linkId: string | null;
  /** Null only for a no-op on the primary wallet of an account that has no mapping yet. */
  participantId: string | null;
  networkIdentity: string;
  address: string;
  status: 'ACTIVE';
}>;
export interface WalletLinkRecord {
  id: string;
  address: string;
  networkIdentity: string;
  status: 'ACTIVE' | 'REVOKED';
  verifiedAt: string;
  revokedAt: string | null;
}
export type PublicWalletLink = Readonly<{
  address: string;
  networkIdentity: string;
  status: 'ACTIVE';
  alreadyLinked: boolean;
}>;

/** Internal credential reservation, never an authenticated-session or public HTTP DTO. */
export type WalletCredentialReservation = Readonly<{
  accountId: string;
  networkIdentity: string;
  status: 'ACTIVE' | 'REVOKED';
  accountSuspended: boolean;
}>;
