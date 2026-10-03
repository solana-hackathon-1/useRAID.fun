import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { db } from './db';
import { usdcRpc, usdcSettings } from './usdc';

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
    const { value } = await rpc.getTokenAccountBalance(
      getAssociatedTokenAddressSync(
        new PublicKey(settings.mint),
        new PublicKey(settings.recipient),
      ),
    );
    custody = BigInt(value.amount);
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
