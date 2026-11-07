/**
 * Why a launch is PAUSED. The stored `TokenLaunch.error` is raw operator text: FinancePauseError can embed the first
 * simulation logs an RPC node returned (URLs, query-string keys) and other reasons carry lamport counts and transaction
 * signatures. Public and owner views carry only a fixed reason from this module; the raw text stays in the row for
 * operators and the admin view.
 *
 * The fixed reasons are shared with the code that stores them (rewards.ts), so the allow-list cannot drift from what
 * is thrown. The dynamic reasons are recognised by shape and replaced by neutral text.
 */
export const PAUSE_REASON = {
  unexpectedFee: 'Unexpected network fee; payouts paused',
  feeChanged: 'Network fee changed before signing',
  recipientOrCurveChanged: 'Fee recipient or bonding curve changed',
  curveRecipientChanged: 'Bonding curve fee recipient changed',
  poolRecipientChanged: 'Graduated pool fee recipient changed',
  claimRecipientMissing: 'Claim recipient missing from transaction',
  negativeClaim: 'Negative claim',
  foreignAuthority: 'Fee wallet wSOL account has foreign authority',
  balanceInsufficient: 'Fee wallet balance insufficient',
} as const;
export const PAUSE_SIMULATION_FAILED = 'Transaction simulation failed; payouts paused';
export const PAUSE_FEE_DIFFERED = 'Network fee differed from the approved amount';
export const PAUSE_ONCHAIN_FAILED = 'An on-chain transaction failed';
export const PAUSE_OPERATOR_REVIEW = 'Operator review required';
/** The only pause text anyone but the launch owner sees (DEC-2026-11-07-01 k). */
export const PAUSE_PUBLIC_TEXT = 'Payouts paused';
const FIXED: ReadonlySet<string> = new Set(Object.values(PAUSE_REASON));
export function publicPausedReason(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (FIXED.has(stored)) return stored;
  if (/^\w+ simulation failed; inspect chain accounts\./.test(stored))
    return PAUSE_SIMULATION_FAILED;
  if (/^Network fee \d+ differed from approved \d+ on /.test(stored)) return PAUSE_FEE_DIFFERED;
  if (/^On-chain \w+ failed; inspect /.test(stored)) return PAUSE_ONCHAIN_FAILED;
  return PAUSE_OPERATOR_REVIEW;
}
