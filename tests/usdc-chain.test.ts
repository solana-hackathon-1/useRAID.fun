import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { UsdcTransfer } from '@prisma/client';
const chain = vi.hoisted(() => ({
  pages: [] as { signature: string; blockTime: number; err: null }[][],
  receipts: {} as Record<string, unknown>,
  calls: 0,
}));
vi.mock('@solana/web3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/web3.js')>()),
  Connection: class {
    getGenesisHash = async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    getSignaturesForAddress = async () => chain.pages[chain.calls++] || [];
    getParsedTransactions = async (sigs: string[]) => sigs.map((s) => chain.receipts[s] || null);
  },
}));
import { findTransferPayment } from '../src/lib/usdc-chain';
import { USDC_MINTS } from '../src/lib/usdc';
const platform = Keypair.generate().publicKey,
  payee = Keypair.generate().publicKey,
  mint = new PublicKey(USDC_MINTS.mainnet);
const intent: UsdcTransfer = {
  id: 'withdrawal-1',
  userId: 'u',
  kind: 'WITHDRAWAL',
  amount: 2_000_000n,
  walletAddress: payee.toBase58(),
  recipient: platform.toBase58(),
  network: 'mainnet',
  mint: mint.toBase58(),
  status: 'REQUESTED',
  signature: null,
  allocationId: null,
  createdAt: new Date(100_000),
  expiresAt: null,
  paidAt: null,
};
const receipt = (id: string, blockTime: number) =>
  ({
    blockTime,
    slot: 1,
    transaction: {
      signatures: [],
      message: {
        accountKeys: [
          { pubkey: platform, signer: true, writable: true },
          {
            pubkey: getAssociatedTokenAddressSync(mint, payee),
            signer: false,
            writable: true,
          },
        ],
        instructions: [
          {
            program: 'spl-memo',
            programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
            parsed: `useRAID:usdc:${id}`,
          },
          {
            program: 'spl-token',
            programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            parsed: {
              type: 'transferChecked',
              info: {
                authority: platform.toBase58(),
                source: getAssociatedTokenAddressSync(mint, platform).toBase58(),
                destination: getAssociatedTokenAddressSync(mint, payee).toBase58(),
                mint: mint.toBase58(),
                tokenAmount: { amount: '2000000', decimals: 6 },
              },
            },
          },
        ],
        recentBlockhash: '',
      },
    },
    meta: {
      err: null,
      fee: 0,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: mint.toBase58(),
          uiTokenAmount: { amount: '2000000', decimals: 6, uiAmount: 2 },
        },
      ],
    },
  }) as unknown as ParsedTransactionWithMeta;
describe('on-chain withdrawal payment lookup', () => {
  beforeEach(() => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://example.invalid');
    chain.pages = [];
    chain.receipts = {};
    chain.calls = 0;
  });
  it('returns the signature of a matching payment', async () => {
    chain.pages = [
      [
        { signature: 'unrelated', blockTime: 150, err: null },
        { signature: 'paid', blockTime: 140, err: null },
      ],
    ];
    chain.receipts = { paid: receipt('withdrawal-1', 140), unrelated: receipt('other', 150) };
    expect(await findTransferPayment(intent)).toBe('paid');
  });
  it('returns null when nothing matches and stops paging at the intent creation time', async () => {
    chain.pages = [
      Array.from({ length: 1000 }, (_, i) => ({ signature: `new${i}`, blockTime: 500, err: null })),
      [{ signature: 'old', blockTime: 50, err: null }],
      [{ signature: 'never', blockTime: 40, err: null }],
    ];
    expect(await findTransferPayment(intent)).toBeNull();
    expect(chain.calls).toBe(2);
  });
  it('never answers for sandbox intents and refuses an inconclusive history', async () => {
    expect(await findTransferPayment({ ...intent, network: 'sandbox' })).toBeNull();
    chain.pages = Array.from({ length: 6 }, () =>
      Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, blockTime: 500, err: null })),
    );
    await expect(findTransferPayment(intent)).rejects.toMatchObject({ status: 503 });
  });
});
