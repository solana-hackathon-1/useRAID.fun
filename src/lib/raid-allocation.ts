import { db } from './db';
import { lockTracking } from './tracking';
import { trackingBlockers, type ResultPayload } from './tracking-review';
import { HttpError } from './auth-primitives';
import { Connection } from '@solana/web3.js';

export function splitImpressionFunding(
  budget: bigint,
  target: number,
  results: { xId: string; walletAddress: string; views: number }[],
) {
  if (
    budget <= 0n ||
    !Number.isSafeInteger(target) ||
    target <= 0 ||
    results.some((r) => !Number.isSafeInteger(r.views) || r.views < 0)
  )
    throw new Error('Invalid funding inputs.');
  const total = results.reduce((sum, r) => sum + BigInt(r.views), 0n);
  const earned =
    total === 0n
      ? 0n
      : (budget * (total < BigInt(target) ? total : BigInt(target))) / BigInt(target);
  const rewards = results
    .filter((r) => r.views > 0)
    .map((r) => ({ ...r, lamports: (earned * BigInt(r.views)) / total }));
  // Rounding dust returns to the creator; allocations can never exceed deposited funds.
  const allocated = rewards.reduce((sum, r) => sum + r.lamports, 0n);
  return { rewards: rewards.filter((r) => r.lamports > 0n), refund: budget - allocated };
}
export async function allocateRaidFunding(raidId: string) {
  return db.$transaction(async (tx) => {
    await lockTracking(tx, raidId);
    const raid = await tx.raid.findUniqueOrThrow({
      where: { id: raidId },
      include: { creator: true },
    });
    if (
      raid.studioVersion === 1 ||
      raid.mint ||
      raid.hidden ||
      raid.creator.suspended ||
      raid.fundingStatus !== 'VERIFIED' ||
      raid.trackingPhase !== 'APPROVED' ||
      !raid.activeResultId ||
      !raid.fundingLamports ||
      !raid.fundingWallet ||
      !raid.impressionTarget
    )
      return;
    if (await trackingBlockers(tx, raidId)) return;
    if (await tx.raidAllocation.count({ where: { raidId } })) return;
    const result = await tx.campaignResult.findUniqueOrThrow({
      where: { id: raid.activeResultId },
    });
    const payload = result.payload as unknown as ResultPayload;
    const posts = payload.contributions.filter(
      (p) =>
        p.qualification === 'QUALIFIED' &&
        p.availability === 'AVAILABLE' &&
        p.reviewStatus !== 'FLAGGED' &&
        !p.hidden &&
        !p.deleted,
    );
    if (posts.some((p) => p.views == null)) return; // Unknown views never mean zero earned.
    if (
      posts.reduce((sum, post) => sum + BigInt(post.views || 0), 0n) >
      BigInt(Number.MAX_SAFE_INTEGER)
    )
      return;
    const shares = splitImpressionFunding(
      BigInt(raid.fundingLamports),
      raid.impressionTarget,
      payload.participants.map((p) => ({
        xId: p.xId,
        walletAddress: p.walletAddress,
        views: posts
          .filter((post) => post.authorId === p.xId)
          .reduce((sum, post) => sum + (post.views || 0), 0),
      })),
    );
    await tx.raidAllocation.createMany({
      data: [
        ...shares.rewards.map((r) => ({
          raidId,
          resultId: result.id,
          kind: 'REWARD',
          xId: r.xId,
          walletAddress: r.walletAddress,
          lamports: r.lamports.toString(),
        })),
        ...(shares.refund > 0n
          ? [
              {
                raidId,
                resultId: result.id,
                kind: 'REFUND',
                xId: null,
                walletAddress: raid.fundingWallet,
                lamports: shares.refund.toString(),
              },
            ]
          : []),
      ],
    });
    await tx.raid.update({ where: { id: raidId }, data: { trackingPhase: 'ALLOCATED' } });
  });
}
export async function recordRaidPayment(allocationId: string, signature: string, actorId: string) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature))
    throw new HttpError(400, 'Invalid transaction signature.');
  const allocation = await db.raidAllocation.findUnique({
    where: { id: allocationId },
    include: { raid: true },
  });
  if (!allocation) throw new HttpError(404, 'Allocation not found.');
  if (allocation.signature === signature) return;
  if (allocation.signature) throw new HttpError(409, 'Allocation already paid.');
  const endpoint = process.env.SOLANA_RPC_URL;
  if (!endpoint?.startsWith('https://'))
    throw new HttpError(503, 'Payment verification unavailable.');
  const rpc = new Connection(endpoint, 'finalized');
  if ((await rpc.getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
    throw new HttpError(503, 'Solana mainnet required.');
  const receipt = await rpc.getParsedTransaction(signature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  });
  const instructions = receipt?.transaction.message.instructions || [];
  if (
    !receipt?.meta ||
    receipt.meta.err ||
    !receipt.blockTime ||
    receipt.blockTime * 1000 < +allocation.raid.createdAt - 1000 ||
    !receipt.transaction.message.accountKeys.some(
      (key) => key.signer && key.pubkey.toBase58() === allocation.raid.fundingRecipient,
    ) ||
    !instructions.some(
      (i) =>
        'parsed' in i && i.program === 'spl-memo' && i.parsed === `useRAID:pay:${allocation.id}`,
    ) ||
    !instructions.some(
      (i) =>
        'parsed' in i &&
        i.program === 'system' &&
        i.parsed?.type === 'transfer' &&
        i.parsed.info.source === allocation.raid.fundingRecipient &&
        i.parsed.info.destination === allocation.walletAddress &&
        Number.isSafeInteger(i.parsed.info.lamports) &&
        BigInt(i.parsed.info.lamports) === BigInt(allocation.lamports),
    )
  )
    throw new HttpError(
      409,
      'Finalized payment must match allocation amount, platform wallet, recipient, and payment memo.',
    );
  await db.$transaction(async (tx) => {
    await lockTracking(tx, allocation.raidId);
    const current = await tx.raidAllocation.findUniqueOrThrow({ where: { id: allocationId } });
    if (current.signature === signature) return;
    if (
      current.signature ||
      current.walletAddress !== allocation.walletAddress ||
      current.lamports !== allocation.lamports
    )
      throw new HttpError(409, 'Allocation changed or already paid.');
    await tx.raidAllocation.update({
      where: { id: allocationId },
      data: { signature, paidAt: new Date() },
    });
    await tx.moderationEvent.create({
      data: {
        actorId,
        action: 'raid-payment-verified',
        targetId: allocationId,
        reason: `Finalized payment ${signature}`,
      },
    });
  });
}
