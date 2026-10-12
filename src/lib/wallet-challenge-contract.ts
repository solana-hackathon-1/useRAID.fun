import { HttpError } from './errors';

/** New challenges use the configured cluster; only local development retains the legacy default. */
export function siwsChainId(): 'devnet' | 'mainnet' {
  const network = process.env.USDC_NETWORK;
  if (network === 'devnet' || network === 'mainnet') return network;
  if (!network && process.env.NODE_ENV !== 'production') return 'mainnet';
  throw new HttpError(503, 'Configure USDC_NETWORK as devnet or mainnet for wallet sign-in.');
}
export const LINK_ADDITIONAL_STATEMENT =
  'Add this wallet for sign-in to your useRAID.fun account. Your payout wallet does not change.';
/** Keep the exposed legacy purposes unchanged until the separately reviewed composing host. */
export const WALLET_CHALLENGE_STATEMENTS = Object.freeze({
  signin: 'Sign in to useRAID.fun.',
  link: 'Link this wallet to your useRAID.fun account.',
  rotate: 'Change the wallet on your useRAID.fun account. Withdrawals pause for 24 hours.',
});

/** Signed host and URI must bind to the host's current configured origin, including port/scheme.
 * Pure host-injected check; path-only configuration changes do not invalidate a pending proof.
 * Signature, digest, purpose, expiry and one-use consumption remain composing-host duties.
 */
export function walletChallengeMatchesOrigin(message: string, appUrl: string): boolean {
  try {
    const origin = new URL(appUrl);
    const lines = message.split('\n');
    return (
      lines[0] === `${origin.host} wants you to sign in with your Solana account:` &&
      lines[5] === `URI: ${origin.origin}`
    );
  } catch {
    return false;
  }
}
