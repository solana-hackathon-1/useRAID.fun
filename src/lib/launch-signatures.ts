import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey, Transaction } from '@solana/web3.js';
import { HttpError } from './auth';
import { walletAddress } from './wallet-auth';

export function verifySignedLaunch(
  rawBase64: string,
  expectation: { preparedHash: string; mint: string; payer: string; programId: PublicKey },
) {
  if (typeof rawBase64 !== 'string' || rawBase64.length > 20000)
    throw new HttpError(400, 'Transaction too large.');
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(rawBase64, 'base64'));
  } catch {
    throw new HttpError(400, 'Invalid signed transaction.');
  }
  const message = tx.serializeMessage();
  if (
    createHash('sha256').update(message).digest('hex') !== expectation.preparedHash ||
    tx.instructions.length !== 1 ||
    !tx.instructions[0].programId.equals(expectation.programId)
  )
    throw new HttpError(400, 'Signed transaction differs from launch review.');
  if (!tx.feePayer?.equals(walletAddress(expectation.payer)))
    throw new HttpError(403, 'Wrong wallet signed launch.');
  const signatures = new Map(tx.signatures.map((s) => [s.publicKey.toBase58(), s.signature]));
  for (const address of [expectation.payer, expectation.mint]) {
    const signature = signatures.get(address);
    if (
      !signature ||
      !nacl.sign.detached.verify(message, signature, walletAddress(address).toBytes())
    )
      throw new HttpError(400, 'Wallet or mint signature invalid.');
  }
  return { tx, raw: tx.serialize(), signature: bs58.encode(signatures.get(expectation.payer)!) };
}
