import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { Prisma, UsdcTransfer } from '@prisma/client';
import { db } from './db';
import { HttpError } from './auth-primitives';
import { config, trackingEnabled, trackingSettlementEnabled } from './config';
import { studioSandbox } from './studio-mode';
export { studioSandbox } from './studio-mode';
import { quoteUsdc, units, formatUsdc } from './usdc-amount';
export { quoteUsdc, units, formatUsdc };

export const USDC_MINTS = {
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
export function usdcSettings() {
  const network = process.env.USDC_NETWORK === 'devnet' ? 'devnet' : 'mainnet';
  const recipient = process.env.USDC_FUNDING_ADDRESS || '';
  const rate = process.env.USDC_MICROS_PER_1000_IMPRESSIONS || '';
  let rateUnits: bigint | null = null;
  if (/^\d{1,15}$/.test(rate) && BigInt(rate) > 0n) rateUnits = BigInt(rate);
  if (studioSandbox())
    return {
      network: 'sandbox',
      mint: USDC_MINTS.devnet,
      recipient: '11111111111111111111111111111111',
      rateUnits: 1_000_000n,
      ready: true,
    };
  let ready = false;
  try {
    ready =
      !config.demo &&
      !!process.env.SOLANA_RPC_URL?.startsWith('https://') &&
      PublicKey.isOnCurve(new PublicKey(recipient).toBytes());
  } catch {}
  return { network, mint: USDC_MINTS[network], recipient, rateUnits, ready };
}
export function usdcLimits() {
  const units = (name: string, fallback: bigint) => {
    const value = process.env[name] || '';
    return /^\d{1,15}$/.test(value) ? BigInt(value) : fallback;
  };
  const count = (name: string, fallback: number) => {
    const value = Number(process.env[name] || fallback);
    return Number.isInteger(value) && value >= 1 ? value : fallback;
  };
  return {
    minDeposit: units('USDC_MIN_DEPOSIT_UNITS', 1_000_000n),
    minWithdrawal: units('USDC_MIN_WITHDRAWAL_UNITS', 1_000_000n),
    minReward: units('USDC_MIN_REWARD_UNITS', 100_000n),
    maxOpenDeposits: count('USDC_MAX_OPEN_DEPOSITS', 3),
    maxOpenWithdrawals: count('USDC_MAX_OPEN_WITHDRAWALS', 3),
  };
}
export async function lockBalance(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`balance:${userId}`}, 0))`;
}
export async function balance(
  userId: string,
  tx: Prisma.TransactionClient = db,
  network = usdcSettings().network,
) {
  const totals = await tx.balanceEntry.aggregate({
    where: { userId, network },
    _sum: { availableDelta: true, reservedDelta: true },
  });
  return { available: totals._sum.availableDelta || 0n, reserved: totals._sum.reservedDelta || 0n };
}
export async function balanceView(userId: string) {
  const network = usdcSettings().network;
  const [totals, entries, transfers] = await Promise.all([
    balance(userId),
    db.balanceEntry.findMany({
      where: { userId, network },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    db.usdcTransfer.findMany({
      where: { userId, network },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);
  return {
    available: totals.available.toString(),
    reserved: totals.reserved.toString(),
    entries: entries.map((e) => ({
      ...e,
      availableDelta: e.availableDelta.toString(),
      reservedDelta: e.reservedDelta.toString(),
      createdAt: e.createdAt.toISOString(),
    })),
    transfers: transfers.map((t) => ({
      ...t,
      amount: t.amount.toString(),
      createdAt: t.createdAt.toISOString(),
      expiresAt: t.expiresAt?.toISOString() || null,
      paidAt: t.paidAt?.toISOString() || null,
    })),
  };
}
export type BalanceView = Awaited<ReturnType<typeof balanceView>>;
export async function usdcRpc(network: string) {
  if (!['mainnet', 'devnet'].includes(network))
    throw new HttpError(503, 'Unsupported payment network.');
  const endpoint = process.env.SOLANA_RPC_URL;
  if (!endpoint?.startsWith('https://'))
    throw new HttpError(503, 'USDC payments are not configured.');
  const rpc = new Connection(endpoint, 'finalized');
  const expected =
    network === 'devnet'
      ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
      : '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  if ((await rpc.getGenesisHash()) !== expected)
    throw new HttpError(503, 'Payment network does not match configured USDC network.');
  return rpc;
}
export function matchesUsdcReceipt(
  receipt: ParsedTransactionWithMeta | null,
  intent: UsdcTransfer,
) {
  if (
    !receipt?.meta ||
    receipt.meta.err ||
    !receipt.blockTime ||
    receipt.blockTime * 1000 < +intent.createdAt - 1000 ||
    (intent.expiresAt && receipt.blockTime * 1000 > +intent.expiresAt)
  )
    return false;
  const sourceOwner = intent.kind === 'DEPOSIT' ? intent.walletAddress : intent.recipient;
  const destinationOwner = intent.kind === 'DEPOSIT' ? intent.recipient : intent.walletAddress;
  const source = getAssociatedTokenAddressSync(
    new PublicKey(intent.mint),
    new PublicKey(sourceOwner),
  ).toBase58();
  const destination = getAssociatedTokenAddressSync(
    new PublicKey(intent.mint),
    new PublicKey(destinationOwner),
  ).toBase58();
  const keys = receipt.transaction.message.accountKeys;
  if (!keys.some((k) => k.signer && k.pubkey.toBase58() === sourceOwner)) return false;
  const instructions = receipt.transaction.message.instructions;
  const memo = instructions.some(
    (i) =>
      'parsed' in i &&
      i.program === 'spl-memo' &&
      i.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' &&
      i.parsed === `useRAID:usdc:${intent.id}`,
  );
  const paid = instructions.some(
    (i) =>
      'parsed' in i &&
      i.program === 'spl-token' &&
      i.programId.equals(TOKEN_PROGRAM_ID) &&
      i.parsed?.type === 'transferChecked' &&
      i.parsed.info.authority === sourceOwner &&
      i.parsed.info.source === source &&
      i.parsed.info.destination === destination &&
      i.parsed.info.mint === intent.mint &&
      i.parsed.info.tokenAmount?.decimals === 6 &&
      i.parsed.info.tokenAmount.amount === intent.amount.toString(),
  );
  const index = keys.findIndex((k) => k.pubkey.toBase58() === destination);
  const before = receipt.meta.preTokenBalances?.find(
    (b) => b.accountIndex === index && b.mint === intent.mint,
  );
  const after = receipt.meta.postTokenBalances?.find(
    (b) => b.accountIndex === index && b.mint === intent.mint,
  );
  return (
    memo &&
    paid &&
    !!after &&
    BigInt(after.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount || '0') ===
      intent.amount
  );
}
export async function createDeposit(userId: string, amount: bigint) {
  if (amount <= 0n || amount > 999_999_999_000_000n)
    throw new HttpError(400, 'Invalid USDC amount.');
  const limits = usdcLimits();
  if (amount < limits.minDeposit)
    throw new HttpError(400, `Minimum deposit is ${formatUsdc(limits.minDeposit)} USDC.`);
  const settings = usdcSettings();
  if (!(await depositsReady()))
    throw new HttpError(503, 'Deposits open when campaign funding and live tracking are ready.');
  const wallet = await db.walletIdentity.findUnique({ where: { userId } });
  if (!wallet) throw new HttpError(403, 'Connect your wallet from Account before depositing.');
  const intent = await db.$transaction(async (tx) => {
    await lockBalance(tx, userId);
    const open = await tx.usdcTransfer.count({
      where: {
        userId,
        kind: 'DEPOSIT',
        status: 'AWAITING_TRANSFER',
        expiresAt: { gt: new Date() },
      },
    });
    if (open >= limits.maxOpenDeposits)
      throw new HttpError(429, 'Finish or wait for your open deposit requests to expire.');
    return tx.usdcTransfer.create({
      data: {
        userId,
        amount,
        kind: 'DEPOSIT',
        status: 'AWAITING_TRANSFER',
        walletAddress: wallet.address,
        recipient: settings.recipient,
        mint: settings.mint,
        network: settings.network,
        expiresAt: new Date(Date.now() + 30 * 60000),
      },
    });
  });
  if (studioSandbox()) return { id: intent.id, transaction: null, network: settings.network };
  const rpc = await usdcRpc(settings.network);
  const source = new PublicKey(wallet.address),
    recipient = new PublicKey(settings.recipient),
    mint = new PublicKey(settings.mint);
  const destination = getAssociatedTokenAddressSync(mint, recipient);
  const tx = new Transaction({ feePayer: source, ...(await rpc.getLatestBlockhash()) }).add(
    createAssociatedTokenAccountIdempotentInstruction(source, destination, recipient, mint),
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(mint, source),
      mint,
      destination,
      source,
      amount,
      6,
    ),
    new TransactionInstruction({
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      keys: [],
      data: Buffer.from(`useRAID:usdc:${intent.id}`),
    }),
  );
  return {
    id: intent.id,
    transaction: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    network: settings.network,
  };
}
export async function depositsReady() {
  const settings = usdcSettings();
  if (!settings.ready || !settings.rateUnits || !trackingEnabled()) return false;
  if (studioSandbox()) return true;
  if (!trackingSettlementEnabled()) return false;
  if (!config.liveApproved || !process.env.X_BEARER_TOKEN) return false;
  return !!(await db.settings.findUnique({ where: { id: 'global' } }))?.collectionEnabled;
}
export async function verifyUsdcTransfer(
  id: string,
  signature: string,
  actorId: string,
  admin = false,
) {
  const intent = await db.usdcTransfer.findUnique({ where: { id } });
  if (!intent || (!admin && (intent.userId !== actorId || intent.kind !== 'DEPOSIT')))
    throw new HttpError(404, 'Transfer not found.');
  if (intent.status === 'PAID' && intent.signature === signature) return;
  if (!['REQUESTED', 'AWAITING_TRANSFER'].includes(intent.status))
    throw new HttpError(409, 'Transfer already completed or rejected.');
  if (intent.network === 'sandbox') {
    if (!studioSandbox() || signature !== `sandbox:${id}`)
      throw new HttpError(403, 'Test transfers are unavailable.');
  } else {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature))
      throw new HttpError(400, 'Invalid transfer signature.');
    const rpc = await usdcRpc(intent.network);
    const receipt = await rpc.getParsedTransaction(signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!matchesUsdcReceipt(receipt, intent))
      throw new HttpError(
        409,
        'Wait for finalization; transfer must match USDC token, amount, wallet, recipient, and memo.',
      );
  }
  await db.$transaction(async (tx) => {
    await lockBalance(tx, intent.userId);
    const current = await tx.usdcTransfer.findUniqueOrThrow({ where: { id } });
    if (current.status === 'PAID' && current.signature === signature) return;
    if (!['REQUESTED', 'AWAITING_TRANSFER'].includes(current.status))
      throw new HttpError(409, 'Transfer state changed.');
    await tx.usdcTransfer.update({
      where: { id },
      data: { status: 'PAID', signature, paidAt: new Date() },
    });
    if (intent.kind === 'DEPOSIT' || intent.kind === 'WITHDRAWAL')
      await tx.balanceEntry.create({
        data: {
          key: `transfer-paid:${id}`,
          userId: intent.userId,
          transferId: id,
          kind: intent.kind,
          network: intent.network,
          availableDelta: intent.kind === 'DEPOSIT' ? intent.amount : 0n,
          reservedDelta: intent.kind === 'WITHDRAWAL' ? -intent.amount : 0n,
        },
      });
    if (admin)
      await tx.moderationEvent.create({
        data: {
          actorId,
          action: 'usdc-payment',
          targetId: id,
          reason: `Finalized payment ${signature}`,
        },
      });
  });
}
export async function requestWithdrawal(userId: string, amount: bigint, requestKey: string) {
  if (amount <= 0n || amount > 999_999_999_000_000n)
    throw new HttpError(400, 'Invalid USDC amount.');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestKey))
    throw new HttpError(400, 'Invalid request identifier.');
  const settings = usdcSettings();
  if (!settings.ready) throw new HttpError(503, 'Withdrawals are not configured.');
  return db.$transaction(async (tx) => {
    await lockBalance(tx, userId);
    const key = `withdraw:${userId}:${requestKey}`;
    const previous = await tx.balanceEntry.findUnique({ where: { key } });
    if (previous?.transferId)
      return tx.usdcTransfer.findUniqueOrThrow({ where: { id: previous.transferId } });
    const limits = usdcLimits();
    if (amount < limits.minWithdrawal)
      throw new HttpError(400, `Minimum withdrawal is ${formatUsdc(limits.minWithdrawal)} USDC.`);
    if (
      (await tx.usdcTransfer.count({
        where: { userId, kind: 'WITHDRAWAL', status: 'REQUESTED' },
      })) >= limits.maxOpenWithdrawals
    )
      throw new HttpError(429, 'Wait for your open withdrawals to be paid or rejected.');
    const wallet = await tx.walletIdentity.findUnique({ where: { userId } });
    if (!wallet) throw new HttpError(403, 'Connect your verified wallet first.');
    if ((await balance(userId, tx)).available < amount)
      throw new HttpError(409, 'Insufficient available USDC.');
    const transfer = await tx.usdcTransfer.create({
      data: {
        kind: 'WITHDRAWAL',
        userId,
        amount,
        walletAddress: wallet.address,
        recipient: settings.recipient,
        mint: settings.mint,
        network: settings.network,
      },
    });
    await tx.balanceEntry.create({
      data: {
        key,
        userId,
        transferId: transfer.id,
        network: settings.network,
        kind: 'WITHDRAWAL_RESERVED',
        availableDelta: -amount,
        reservedDelta: amount,
      },
    });
    return transfer;
  });
}
export async function rejectWithdrawal(id: string, actorId: string, reason: string) {
  const intent = await db.usdcTransfer.findUniqueOrThrow({ where: { id } });
  if (intent.kind !== 'WITHDRAWAL' || !reason.trim())
    throw new HttpError(400, 'Only unpaid withdrawals can be rejected with a reason.');
  await db.$transaction(async (tx) => {
    await lockBalance(tx, intent.userId);
    const current = await tx.usdcTransfer.findUniqueOrThrow({ where: { id } });
    if (current.status !== 'REQUESTED') throw new HttpError(409, 'Withdrawal state changed.');
    await tx.usdcTransfer.update({ where: { id }, data: { status: 'REJECTED' } });
    await tx.balanceEntry.create({
      data: {
        key: `withdraw-rejected:${id}`,
        userId: intent.userId,
        transferId: id,
        network: intent.network,
        kind: 'WITHDRAWAL_RELEASED',
        availableDelta: intent.amount,
        reservedDelta: -intent.amount,
      },
    });
    await tx.moderationEvent.create({
      data: { actorId, action: 'withdrawal-rejected', targetId: id, reason: reason.trim() },
    });
  });
}
