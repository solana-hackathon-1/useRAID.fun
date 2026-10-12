/** Legacy SIWS vocabulary; configured network binding remains T007's responsibility. */
export const SIWS_CHAIN_ID = 'mainnet';
export const LINK_ADDITIONAL_STATEMENT =
  'Add this wallet for sign-in to your useRAID.fun account. Your payout wallet does not change.';
/** Keep the exposed legacy purposes unchanged until the separately reviewed composing host. */
export const WALLET_CHALLENGE_STATEMENTS = Object.freeze({
  signin: 'Sign in to useRAID.fun.',
  link: 'Link this wallet to your useRAID.fun account.',
  rotate: 'Change the wallet on your useRAID.fun account. Withdrawals pause for 24 hours.',
});
