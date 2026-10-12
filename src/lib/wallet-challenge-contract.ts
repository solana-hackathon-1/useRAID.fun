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
