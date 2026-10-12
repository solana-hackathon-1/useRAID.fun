import type { IdentityTransaction } from '../identity-storage';
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
  | 'PRIMARY_WALLET_PROTECTED'
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
  /** Host-built session observation: `{ accountId, state, expiresAt }`. Ignored when `observeAuthority` is supplied. */
  session?: unknown;
  /** Host `IdentityLinkPolicy`: domain, uri, supported wallet networks. */
  policy: unknown;
  /** Host clock (UTC ISO). The module never reads the system clock. Ignored when `observeAuthority` is supplied. */
  now?: unknown;
  /**
   * Optional host hook, awaited AFTER the wallet-subject and account locks are held and before
   * the preflight. It returns the `{ session, now }` observation used for the decision, so a
   * session or authority change committed while this command waited for those locks is seen. The
   * host should row-lock what it reads until commit. Throw `IdentityLinkError` to deny; any other
   * thrown value is reported as `STORAGE_UNAVAILABLE`.
   */
  observeAuthority?: (tx: IdentityTransaction) => Promise<{ session: unknown; now: unknown }>;
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

export interface ResolveWalletCredentialInput {
  subject: { networkIdentity: string; address: string };
  /** Host-approved network policy, not an HTTP body field. */
  walletNetworks: readonly string[];
}
/** Internal context only: use inside the same live transaction; it is not authentication. */
export type WalletCredentialContext =
  | Readonly<{ source: 'ABSENT' }>
  | Readonly<{
      source: 'PRIMARY' | 'LINK';
      accountId: string;
      /** A PRIMARY may be a legitimate unmapped legacy account; never provision on sign-in. */
      participantId: string | null;
      linkId: string | null;
      networkIdentity: string;
      address: string;
    }>;
export interface RevokeWalletCredentialInput extends ResolveWalletCredentialInput {
  accountId: string;
  actorAccountId: string;
  requestId: string;
  /** Active self-session observation supplied by an authenticated host. */
  session: unknown;
  now: unknown;
}
export type RevokeWalletCredentialResult = Readonly<{
  outcome: 'REVOKED' | 'ALREADY_REVOKED';
  linkId: string;
  participantId: string;
  address: string;
  networkIdentity: string;
  status: 'REVOKED';
  revokedAt: string;
}>;

/** Internal credential reservation, never an authenticated-session or public HTTP DTO. */
export type WalletCredentialReservation = Readonly<{
  accountId: string;
  networkIdentity: string;
  status: 'ACTIVE' | 'REVOKED';
  accountSuspended: boolean;
}>;
