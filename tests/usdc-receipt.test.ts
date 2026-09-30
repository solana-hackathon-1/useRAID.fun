import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { UsdcTransfer } from '@prisma/client';
import { matchesUsdcReceipt, USDC_MINTS } from '../src/lib/usdc';
const sourceOwner = Keypair.generate().publicKey,
  destinationOwner = Keypair.generate().publicKey;
const mint = new PublicKey(USDC_MINTS.mainnet),
  source = getAssociatedTokenAddressSync(mint, sourceOwner),
  destination = getAssociatedTokenAddressSync(mint, destinationOwner);
const intent: UsdcTransfer = {
  id: 'receipt-test',
  userId: 'creator',
  kind: 'DEPOSIT',
  amount: 1000000n,
  walletAddress: sourceOwner.toBase58(),
  recipient: destinationOwner.toBase58(),
  network: 'mainnet',
  mint: mint.toBase58(),
  status: 'AWAITING_TRANSFER',
  signature: null,
  allocationId: null,
  createdAt: new Date(100000),
  expiresAt: new Date(200000),
  paidAt: null,
};
function receipt(): ParsedTransactionWithMeta {
  return {
    blockTime: 150,
    slot: 1,
    transaction: {
      signatures: [],
      message: {
        accountKeys: [
          { pubkey: sourceOwner, signer: true, writable: true },
          { pubkey: destination, signer: false, writable: true },
        ],
        instructions: [
          {
            program: 'spl-memo',
            programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
            parsed: 'useRAID:usdc:receipt-test',
          },
          {
            program: 'spl-token',
            programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            parsed: {
              type: 'transferChecked',
              info: {
                authority: sourceOwner.toBase58(),
                source: source.toBase58(),
                destination: destination.toBase58(),
                mint: mint.toBase58(),
                tokenAmount: { amount: '1000000', decimals: 6 },
              },
            },
          },
        ],
        recentBlockhash: '',
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: mint.toBase58(),
          uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 },
        },
      ],
    },
  };
}
describe('USDC finalized receipt evidence', () => {
  it('accepts exact signed transfer and matching memo', () =>
    expect(matchesUsdcReceipt(receipt(), intent)).toBe(true));
  it('rejects failed, stale, expired or missing evidence', () => {
    expect(matchesUsdcReceipt(null, intent)).toBe(false);
    for (const time of [98, 201]) {
      const r = receipt();
      r.blockTime = time;
      expect(matchesUsdcReceipt(r, intent)).toBe(false);
    }
    const r = receipt();
    r.meta!.err = 'failure';
    expect(matchesUsdcReceipt(r, intent)).toBe(false);
  });
  it('rejects altered amount, mint, wallet, authority, destination, memo and decimals', () => {
    for (const [key, value] of [
      ['authority', destinationOwner.toBase58()],
      ['mint', USDC_MINTS.devnet],
      ['destination', source.toBase58()],
      ['source', destination.toBase58()],
    ]) {
      const r = receipt();
      const i = r.transaction.message.instructions[1];
      if ('parsed' in i) i.parsed.info[key] = value;
      expect(matchesUsdcReceipt(r, intent)).toBe(false);
    }
    for (const amount of ['999999', '1000001']) {
      const r = receipt(),
        i = r.transaction.message.instructions[1];
      if ('parsed' in i) i.parsed.info.tokenAmount.amount = amount;
      expect(matchesUsdcReceipt(r, intent)).toBe(false);
    }
    const r = receipt(),
      i = r.transaction.message.instructions[0];
    if ('parsed' in i) i.parsed = 'useRAID:usdc:another-intent';
    expect(matchesUsdcReceipt(r, intent)).toBe(false);
    const other = receipt();
    other.transaction.message.accountKeys[0].signer = false;
    expect(matchesUsdcReceipt(other, intent)).toBe(false);
    const decimals = receipt(),
      transfer = decimals.transaction.message.instructions[1];
    if ('parsed' in transfer) transfer.parsed.info.tokenAmount.decimals = 9;
    expect(matchesUsdcReceipt(decimals, intent)).toBe(false);
  });
  it('requires exact net credit, not a transfer reverted within same transaction', () => {
    const r = receipt();
    r.meta!.postTokenBalances![0].uiTokenAmount.amount = '0';
    expect(matchesUsdcReceipt(r, intent)).toBe(false);
  });
});
