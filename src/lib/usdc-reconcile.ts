import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { db } from './db';
import { usdcRpc, usdcSettings } from './usdc';

// Only the RPC's "account not found" answer (JSON-RPC -32602 "Invalid param: could not find account").
// Every other RPC or transport error, including other -32602 invalid params, must still surface.
function isAccountNotFound(error: unknown) {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return (
    code === -32602 && typeof message === 'string' && message.includes('could not find account')
  );
}

export async function reconcileUsdc(network = usdcSettings().network) {
  const settings = usdcSettings();
  const [ledger, rewards, unconfirmedDeposits] = await Promise.all([
    db.balanceEntry.aggregate({
      where: { network },
      _sum: { availableDelta: true, reservedDelta: true },
    }),
    db.usdcTransfer.aggregate({
      where: { network, kind: 'REWARD', status: 'REQUESTED' },
      _sum: { amount: true },
    }),
    db.usdcTransfer.count({ where: { network, kind: 'DEPOSIT', status: 'AWAITING_TRANSFER' } }),
  ]);
  const available = ledger._sum.availableDelta || 0n,
    reserved = ledger._sum.reservedDelta || 0n,
    pendingRewards = rewards._sum.amount || 0n,
    liabilities = available + reserved;
  let custody: bigint | null = null;
  if (network !== 'sandbox') {
    const rpc = await usdcRpc(network);
    try {
      const { value } = await rpc.getTokenAccountBalance(
        getAssociatedTokenAddressSync(
          new PublicKey(settings.mint),
          new PublicKey(settings.recipient),
        ),
      );
      custody = BigInt(value.amount);
    } catch (error) {
      // The custody ATA does not exist until the first deposit lands: that is zero custody, not a failure.
      if (!isAccountNotFound(error)) throw error;
      custody = 0n;
    }
  }
  return {
    network,
    available,
    reserved,
    liabilities,
    pendingRewards,
    custody,
    unconfirmedDeposits,
    surplus: custody === null ? null : custody - liabilities - pendingRewards,
  };
}
export type UsdcReconciliation = Awaited<ReturnType<typeof reconcileUsdc>>;
export function reconciliationJson(r: UsdcReconciliation) {
  return Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
  );
}
