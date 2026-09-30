import { Connection, PublicKey } from '@solana/web3.js';
import { db } from './db';
import { HttpError } from './auth-primitives';
import { lockTracking } from './tracking';
import { config } from './config';

export function fundingPricing() {
  const rate = Number(process.env.RAID_LAMPORTS_PER_1000_IMPRESSIONS);
  const recipient = process.env.RAID_FUNDING_ADDRESS || '';
  try {
    if (
      config.demo ||
      !config.liveApproved ||
      !process.env.X_BEARER_TOKEN ||
      !process.env.SOLANA_RPC_URL?.startsWith('https://') ||
      !Number.isSafeInteger(rate) ||
      rate <= 0 ||
      !recipient
    )
      return null;
    new PublicKey(recipient);
    if (!PublicKey.isOnCurve(new PublicKey(recipient).toBytes())) return null;
    return { lamportsPerThousand: rate, recipient };
  } catch {
    return null;
  }
}
export function fundingQuote(target: number, rate: number) {
  if (
    !Number.isSafeInteger(target) ||
    target < 1000 ||
    target > 1_000_000_000 ||
    !Number.isSafeInteger(rate) ||
    rate <= 0
  )
    throw new HttpError(400, 'Invalid impression target or funding price.');
  const lamports = (BigInt(target) * BigInt(rate) + 999n) / 1000n;
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER))
    throw new HttpError(400, 'Funding quote exceeds supported amount.');
  return lamports.toString();
}
export async function verifyRaidFunding(raidId: string, userId: string, signature: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature))
    throw new HttpError(400, 'Invalid transaction signature.');
  const raid = await db.raid.findUnique({ where: { id: raidId } });
  const wallet = await db.walletIdentity.findUnique({ where: { userId } });
  if (!raid || raid.creatorId !== userId) throw new HttpError(404, 'Raid not found.');
  if (
    raid.studioVersion === 1 ||
    raid.mint ||
    raid.status !== 'DRAFT' ||
    !raid.fundingLamports ||
    !raid.fundingRecipient
  )
    throw new HttpError(409, 'This Raid has no payable funding quote.');
  if (raid.fundingSignature === signature) return { funded: true };
  if (raid.fundingSignature) throw new HttpError(409, 'Raid is already funded.');
  if (!wallet) throw new HttpError(403, 'Verify the funding wallet first.');
  const endpoint = process.env.SOLANA_RPC_URL;
  if (!endpoint?.startsWith('https://'))
    throw new HttpError(503, 'Funding verification is not configured.');
  const rpc = new Connection(endpoint, 'finalized');
  if ((await rpc.getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
    throw new HttpError(503, 'Funding requires Solana mainnet.');
  const receipt = await rpc.getParsedTransaction(signature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  });
  if (
    !receipt ||
    !receipt.meta ||
    receipt.meta.err ||
    !receipt.blockTime ||
    receipt.blockTime * 1000 < +raid.createdAt - 1000
  )
    throw new HttpError(
      409,
      'Funding transaction is not finalized, failed, or predates this Raid.',
    );
  const signed = receipt.transaction.message.accountKeys.some(
    (key) => key.signer && key.pubkey.toBase58() === wallet.address,
  );
  const instructions = receipt.transaction.message.instructions;
  const memo = instructions.some(
    (instruction) =>
      'parsed' in instruction &&
      instruction.program === 'spl-memo' &&
      instruction.parsed === `useRAID:${raid.id}`,
  );
  const paid = instructions.some(
    (instruction) =>
      'parsed' in instruction &&
      instruction.program === 'system' &&
      instruction.parsed?.type === 'transfer' &&
      instruction.parsed.info.source === wallet.address &&
      instruction.parsed.info.destination === raid.fundingRecipient &&
      Number.isSafeInteger(instruction.parsed.info.lamports) &&
      BigInt(instruction.parsed.info.lamports) === BigInt(raid.fundingLamports!),
  );
  if (!signed || !memo || !paid)
    throw new HttpError(
      400,
      'Funding must match the quoted amount, verified wallet, recipient, and Raid memo.',
    );
  await db.$transaction(async (tx) => {
    await lockTracking(tx, raidId);
    const current = await tx.raid.findUniqueOrThrow({ where: { id: raidId } });
    if (current.fundingSignature === signature) return;
    if (
      current.fundingSignature ||
      current.status !== 'DRAFT' ||
      current.fundingLamports !== raid.fundingLamports ||
      current.fundingRecipient !== raid.fundingRecipient
    )
      throw new HttpError(409, 'Funding quote or state changed.');
    await tx.raid.update({
      where: { id: raidId },
      data: {
        fundingStatus: 'VERIFIED',
        fundingSignature: signature,
        fundedAt: new Date(),
        fundingWallet: wallet.address,
      },
    });
  });
  return { funded: true };
}
