import type { Wallet } from '@wallet-standard/base';
// MetaMask is not offered: it is not a supported sign-in wallet for RAID.
const EXCLUDED = new Set(['metamask']);
export function selectableWallets(wallets: readonly Wallet[]) {
  return wallets.filter(
    (w) =>
      !EXCLUDED.has(w.name.trim().toLowerCase()) &&
      w.chains.includes('solana:mainnet') &&
      'standard:connect' in w.features &&
      'solana:signMessage' in w.features,
  );
}
