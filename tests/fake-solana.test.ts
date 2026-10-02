import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { decodeTransfers, FakeRpc, MAINNET_GENESIS_HASH } from './helpers/fake-solana';
import { assertMainnet } from '../src/lib/pump-launch';
import { __test } from '../src/lib/rewards';

describe('fake Solana harness', () => {
  it('satisfies the mainnet check and records simulated and sent transactions', async () => {
    const rpc = new FakeRpc();
    expect(await rpc.getGenesisHash()).toBe(MAINNET_GENESIS_HASH);
    await expect(assertMainnet(rpc.asConnection())).resolves.toBeUndefined();
    rpc.genesisHash = 'other';
    await expect(assertMainnet(rpc.asConnection())).rejects.toThrow(/mainnet/);
  });
  it('decodes system transfers from a serialized transaction', () => {
    const payer = Keypair.generate(),
      to = Keypair.generate().publicKey;
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
    }).add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 42 }));
    tx.sign(payer);
    expect(decodeTransfers(tx.serialize())).toEqual({
      feePayer: payer.publicKey.toBase58(),
      transfers: [{ from: payer.publicKey.toBase58(), to: to.toBase58(), lamports: 42 }],
    });
  });
  it('exposes the reward internals for tests', () => {
    expect(Object.keys(__test).sort()).toEqual(
      [
        'claimFees',
        'payRound',
        'reconcileFinancial',
        'recordAndBroadcast',
        'verifyFeeRecipient',
      ].sort(),
    );
  });
});
