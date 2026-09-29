import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { verifySignedLaunch } from '../src/lib/launch-signatures';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

function fixture() {
  const payer = Keypair.generate();
  const mint = Keypair.generate();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [{ pubkey: mint.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([1]),
    }),
  );
  const preparedHash = createHash('sha256').update(tx.serializeMessage()).digest('hex');
  tx.sign(payer, mint);
  return {
    tx,
    expectation: {
      preparedHash,
      mint: mint.publicKey.toBase58(),
      payer: payer.publicKey.toBase58(),
      programId: PUMP_PROGRAM_ID,
    },
  };
}

describe('signed pump.fun launch review', () => {
  it('accepts exact reviewed message with payer and mint signatures', () => {
    const { tx, expectation } = fixture();
    const verified = verifySignedLaunch(tx.serialize().toString('base64'), expectation);
    expect(verified.signature).toBeTruthy();
    expect(verified.raw).toEqual(tx.serialize());
  });
  it('rejects changed instruction, changed payer, and missing signature', () => {
    const { tx, expectation } = fixture();
    const changed = Transaction.from(tx.serialize());
    changed.instructions[0].data = Buffer.from([2]);
    expect(() =>
      verifySignedLaunch(
        changed
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        expectation,
      ),
    ).toThrow('differs from launch review');
    expect(() =>
      verifySignedLaunch(tx.serialize().toString('base64'), {
        ...expectation,
        payer: Keypair.generate().publicKey.toBase58(),
      }),
    ).toThrow('Wrong wallet');
    const unsigned = Transaction.from(tx.serialize());
    unsigned.signatures[1].signature = null;
    expect(() =>
      verifySignedLaunch(
        unsigned
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString('base64'),
        expectation,
      ),
    ).toThrow('signature invalid');
  });
});
