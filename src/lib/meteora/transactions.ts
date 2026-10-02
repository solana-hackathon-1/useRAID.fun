import { createHash } from 'node:crypto';
import { Keypair, PublicKey, Transaction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { HttpError } from '../auth-primitives';
import { db } from '../db';
export const messageHash = (tx: Transaction) => createHash('sha256').update(tx.serializeMessage()).digest('hex');
export function verifyReviewedTransaction(raw: string, expected: { messageHash: string; payer: string }) {
  if (typeof raw !== 'string' || raw.length > 24000) throw new HttpError(400, 'Invalid signed transaction.');
  let tx: Transaction;
  try { tx = Transaction.from(Buffer.from(raw, 'base64')); } catch { throw new HttpError(400, 'Invalid signed transaction.'); }
  if (messageHash(tx) !== expected.messageHash || tx.feePayer?.toBase58() !== expected.payer)
    throw new HttpError(400, 'Signed transaction differs from review.');
  if (!tx.verifySignatures()) throw new HttpError(400, 'Required transaction signatures are invalid.');
  const payerSignature = tx.signatures.find(s => s.publicKey.toBase58() === expected.payer)?.signature;
  if (!payerSignature) throw new HttpError(400, 'Wallet signature required.');
  return { tx, raw: tx.serialize(), signature: bs58.encode(payerSignature) };
}
export async function prepareStep(rpc: Connection, launchId: string, key: string, kind: string, label: string,
  payer: PublicKey, transaction: Transaction, signers: Keypair[] = [], metadata?: object) {
  const existing = await db.launchStep.findUnique({ where: { launchId_key: { launchId, key } } });
  if (existing && ['SUBMITTED','CONFIRMED'].includes(existing.status)) return existing;
  const latest = await rpc.getLatestBlockhash('finalized');
  const height = await rpc.getBlockHeight('finalized');
  transaction.feePayer = payer; transaction.recentBlockhash = latest.blockhash;
  const required = new Set(transaction.compileMessage().accountKeys.slice(0, transaction.compileMessage().header.numRequiredSignatures).map(k => k.toBase58()));
  const included = signers.filter(s => required.has(s.publicKey.toBase58()));
  if (included.length) transaction.partialSign(...included);
  const bytes = transaction.serialize({ requireAllSignatures: false });
  if (bytes.length > 1232) throw new HttpError(503, 'Launch transaction exceeds Solana size limit.');
  const data = { kind, label, payer: payer.toBase58(), status: 'PLANNED',
    transaction: bytes.toString('base64'), messageHash: messageHash(transaction),
    blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, signature: null, error: null,
    expiresAt: kind === 'TRADE' ? new Date(Date.now()+15000) : null,
    ...(metadata ? { metadata: JSON.parse(JSON.stringify(metadata)) } : {}) };
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`meteora-step:${launchId}:${key}`}))`;
    const current = await tx.launchStep.findUnique({ where: { launchId_key: { launchId, key } } });
    if (!current) return tx.launchStep.create({ data: { ...data, launchId, key } });
    if (['SUBMITTED','CONFIRMED'].includes(current.status)) return current;
    if (current.status === 'PLANNED' && current.lastValidBlockHeight && height <= current.lastValidBlockHeight &&
        (!current.expiresAt || current.expiresAt > new Date())) return current;
    // Submission can race this lock: only replace the exact unsigned message we read.
    await tx.launchStep.updateMany({ where: { id: current.id, status: current.status, messageHash: current.messageHash }, data });
    return tx.launchStep.findUniqueOrThrow({ where: { id: current.id } });
  });
}
export async function reconcileStep(rpc: Connection, id: string) {
  const step = await db.launchStep.findUniqueOrThrow({ where: { id } });
  if (step.status === 'CONFIRMED' || !step.signature) return step;
  const status = (await rpc.getSignatureStatuses([step.signature], { searchTransactionHistory: true })).value[0];
  if (status?.err) return db.launchStep.update({ where: { id }, data: { status: 'FAILED', error: 'Transaction failed onchain.' } });
  if (status?.confirmationStatus === 'finalized') return db.launchStep.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: new Date(), error: null } });
  if (!status && step.lastValidBlockHeight && await rpc.getBlockHeight('finalized') > step.lastValidBlockHeight) {
    return db.launchStep.update({ where: { id }, data: { status: 'EXPIRED', error: 'Transaction expired. Rebuild and sign again.' } });
  }
  return step;
}
export async function submitStep(rpc: Connection, id: string, raw: string, payer: string) {
  let step = await reconcileStep(rpc, id);
  if (step.payer !== payer) throw new HttpError(403, 'Connect the wallet used for this transaction.');
  if (['SUBMITTED','CONFIRMED'].includes(step.status)) return step;
  if (step.status !== 'PLANNED' || !step.messageHash) throw new HttpError(409, 'Prepare transaction again.');
  if (step.expiresAt && step.expiresAt < new Date()) throw new HttpError(409, 'Quote expired. Get a new quote.');
  if (await rpc.getBlockHeight('finalized') > step.lastValidBlockHeight!) throw new HttpError(409, 'Transaction expired. Prepare again.');
  const signed = verifyReviewedTransaction(raw, { messageHash: step.messageHash, payer });
  // Persist before broadcasting. A timeout must never cause a second payment/launch.
  const changed = await db.launchStep.updateMany({ where: { id, status: 'PLANNED', messageHash: step.messageHash },
    data: { status: 'SUBMITTED', signature: signed.signature, transaction: signed.raw.toString('base64') } });
  if (!changed.count) return db.launchStep.findUniqueOrThrow({ where: { id } });
  try { await rpc.sendRawTransaction(signed.raw, { skipPreflight: false, maxRetries: 3 }); }
  catch { /* Submission outcome is ambiguous until signature reconciliation. */ }
  return reconcileStep(rpc, id);
}
export async function rebroadcastStep(rpc: Connection, id: string) {
  const step = await reconcileStep(rpc, id);
  if (step.status === 'SUBMITTED' && step.transaction) {
    try { await rpc.sendRawTransaction(Buffer.from(step.transaction, 'base64'), { skipPreflight: false, maxRetries: 3 }); } catch {}
  }
  return reconcileStep(rpc, id);
}
