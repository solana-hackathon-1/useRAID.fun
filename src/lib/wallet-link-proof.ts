import { createHash } from 'node:crypto';
import { IdentityLinkError } from '../identity-link';
import { LINK_ADDITIONAL_STATEMENT } from './wallet-challenge-contract';
export { LINK_ADDITIONAL_STATEMENT, siwsChainId } from './wallet-challenge-contract';

/**
 * Thin proof adapter between the host's stored wallet challenge and the pure identity preflight
 * (WR11). T007 owns nonce, domain, Chain ID and signature policy and may replace this file without
 * touching link storage. Every observed field is parsed strictly from the exact message the server
 * generated for this digest; anything missing or non-matching is PROOF_INVALID and nothing is ever
 * defaulted (in particular `issuedAt` is never "now").
 */
export interface StoredWalletChallenge {
  digest: string;
  address: string;
  message: string;
  userId: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;
const invalid = (): never => {
  throw new IdentityLinkError('PROOF_INVALID');
};
function iso(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(+time) || time.toISOString() !== value) return invalid();
  return value;
}
function field(line: string, prefix: string): string {
  return line.startsWith(prefix) ? line.slice(prefix.length) : invalid();
}

/**
 * `challenge` is the stored row as read BEFORE the host's atomic claim; the returned observation
 * therefore reports `consumed: false` (the host claims it in the same transaction as the link).
 * `signatureVerified` must come from the host's own signature check of this exact message.
 */
export function deriveWalletLinkProof(
  challenge: StoredWalletChallenge,
  options: { signatureVerified: boolean; expectedStatement?: string },
) {
  const statement = options.expectedStatement ?? LINK_ADDITIONAL_STATEMENT;
  if (!challenge.userId || challenge.consumedAt) return invalid();
  const lines = challenge.message.split('\n');
  if (lines.length !== 11) return invalid();
  const header = / wants you to sign in with your Solana account:$/;
  const domain = header.test(lines[0]) ? lines[0].replace(header, '') : invalid();
  if (!HOST.test(domain)) return invalid();
  if (
    lines[1] !== challenge.address ||
    lines[2] !== '' ||
    lines[3] !== statement ||
    lines[4] !== ''
  )
    return invalid();
  const uri = field(lines[5], 'URI: ');
  try {
    if (new URL(uri).origin !== uri) return invalid();
  } catch {
    return invalid();
  }
  if (lines[6] !== 'Version: 1') return invalid();
  const chain = field(lines[7], 'Chain ID: ');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(chain)) return invalid();
  if (!/^[A-Za-z0-9_-]{16,}$/.test(field(lines[8], 'Nonce: '))) return invalid();
  const issuedAt = iso(field(lines[9], 'Issued At: '));
  const expiresAt = iso(field(lines[10], 'Expiration Time: '));
  if (
    expiresAt !== challenge.expiresAt.toISOString() ||
    Date.parse(issuedAt) >= Date.parse(expiresAt)
  )
    return invalid();
  if (challenge.digest !== createHash('sha256').update(challenge.message).digest('hex'))
    return invalid();
  return {
    ref: challenge.digest,
    state: options.signatureVerified ? ('VERIFIED' as const) : ('UNVERIFIED' as const),
    accountId: challenge.userId,
    intent: 'LINK' as const,
    subject: { kind: 'WALLET' as const, networkIdentity: chain, address: challenge.address },
    domain,
    uri,
    issuedAt,
    expiresAt,
    consumed: false,
  };
}
