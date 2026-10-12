/** v1 internal observation: supplied by a trusted host, never by an HTTP caller. */
export type WalletSessionObservation = Readonly<{
  userId: string;
  via: string;
  expiresAt: Date;
}>;

/** Preserve X authority only after the host atomically takes a live own session. */
export function walletSessionAuthority(
  previous: WalletSessionObservation | null | undefined,
  authenticatedAccountId: string | undefined,
  resolvedAccountId: string,
  now: Date,
): 'wallet' | 'x' {
  return authenticatedAccountId === resolvedAccountId &&
    previous?.userId === resolvedAccountId &&
    previous.via === 'x' &&
    Number.isFinite(now.getTime()) &&
    previous.expiresAt.getTime() > now.getTime()
    ? 'x'
    : 'wallet';
}
