import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { UsdcTransfer } from '@prisma/client';
import { HttpError } from './auth-primitives';
import { matchesUsdcReceipt, usdcRpc } from './usdc';

const PAGE = 1000,
  MAX_PAGES = 5;

export async function findTransferPayment(intent: UsdcTransfer): Promise<string | null> {
  if (intent.network === 'sandbox') return null;
  const rpc = await usdcRpc(intent.network);
  const destination = getAssociatedTokenAddressSync(
    new PublicKey(intent.mint),
    new PublicKey(intent.walletAddress),
  );
  const since = +intent.createdAt - 1000;
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await rpc.getSignaturesForAddress(
      destination,
      { before, limit: PAGE },
      'finalized',
    );
    if (!batch.length) return null;
    const candidates = batch.filter((s) => !s.err && (!s.blockTime || s.blockTime * 1000 >= since));
    if (candidates.length) {
      const receipts = await rpc.getParsedTransactions(
        candidates.map((s) => s.signature),
        { commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      );
      const index = receipts.findIndex((r) => matchesUsdcReceipt(r, intent));
      if (index >= 0) return candidates[index].signature;
    }
    const last = batch[batch.length - 1];
    if (batch.length < PAGE || (last.blockTime && last.blockTime * 1000 < since)) return null;
    before = last.signature;
  }
  throw new HttpError(
    503,
    'Could not rule out an on-chain payment for this withdrawal; try again or verify the signature.',
  );
}
