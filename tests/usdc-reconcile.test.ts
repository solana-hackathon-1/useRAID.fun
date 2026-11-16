import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, SolanaJSONRPCError } from '@solana/web3.js';
import { USDC_MINTS } from '../src/lib/usdc';

// A plain function (not vi.fn) so a rejecting RPC stub is not tracked as an unhandled rejection.
const rpc = vi.hoisted(() => ({
  balance: async (): Promise<{ value: { amount: string } }> => ({ value: { amount: '0' } }),
}));
vi.mock('../src/lib/db', () => ({
  db: {
    balanceEntry: {
      aggregate: vi.fn(async () => ({
        _sum: { availableDelta: 700_000n, reservedDelta: 300_000n },
      })),
    },
    usdcTransfer: {
      aggregate: vi.fn(async () => ({ _sum: { amount: 200_000n } })),
      count: vi.fn(async () => 0),
    },
  },
}));
vi.mock('../src/lib/usdc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/usdc')>()),
  usdcSettings: () => ({
    network: 'devnet',
    mint: USDC_MINTS.devnet,
    recipient: Keypair.generate().publicKey.toBase58(),
    rateUnits: 1n,
    ready: true,
  }),
  usdcRpc: async () => ({ getTokenAccountBalance: () => rpc.balance() }),
}));
import { reconcileUsdc } from '../src/lib/usdc-reconcile';

const rpcError = (code: number, message: string) =>
  new SolanaJSONRPCError({ code, message }, 'failed to get token account balance');
const failWith = (error: Error) => {
  rpc.balance = async () => {
    throw error;
  };
};

describe('reconcileUsdc custody lookup', () => {
  beforeEach(() => {
    rpc.balance = async () => ({ value: { amount: '0' } });
  });

  it('reads custody from the token account balance when the account exists', async () => {
    rpc.balance = async () => ({ value: { amount: '1500000' } });
    expect(await reconcileUsdc('devnet')).toMatchObject({ custody: 1_500_000n, surplus: 300_000n });
  });

  it('treats a custody ATA that does not exist yet (before the first deposit) as zero custody', async () => {
    failWith(rpcError(-32602, 'Invalid param: could not find account'));
    expect(await reconcileUsdc('devnet')).toMatchObject({
      network: 'devnet',
      custody: 0n,
      liabilities: 1_000_000n,
      pendingRewards: 200_000n,
      surplus: -1_200_000n,
    });
  });

  it.each([
    ['other invalid param under -32602', () => rpcError(-32602, 'Invalid param: WrongSize')],
    ['account-not-found text under another code', () => rpcError(-32005, 'could not find account')],
    ['rate limiting', () => rpcError(429, 'Too many requests')],
    ['transport failure', () => new Error('fetch failed')],
  ])('still throws on %s', async (_name, make) => {
    const error = make();
    failWith(error);
    await expect(reconcileUsdc('devnet')).rejects.toBe(error);
  });
});
