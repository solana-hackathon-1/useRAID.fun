import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  getPriceFromSqrtPrice,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { DynamicFeeSharingClient } from '@meteora-ag/dynamic-fee-sharing-sdk';
import BN from 'bn.js';
import { z } from 'zod';
import { db } from '../db';
import { HttpError } from '../auth-primitives';
import { config } from '../config';
import { meteoraConnection, meteoraNetwork, assertMeteoraNetwork } from './config';
import { parseUnits } from './amounts';
import { prepareStep, submitStep, rebroadcastStep } from './transactions';
import { refreshLaunchState } from './state';
export async function tradableLaunch(mint: string) {
  const launch = await db.tokenLaunch.findUnique({ where: { mint }, include: { user: true } });
  if (
    !launch ||
    launch.provider !== 'METEORA' ||
    launch.network !== meteoraNetwork() ||
    launch.user.suspended ||
    launch.status !== 'LIVE'
  )
    throw new HttpError(404, 'Active launch not found.');
  return launch;
}
const quoteInput = z.object({
  side: z.enum(['BUY', 'SELL']),
  amount: z.string().max(40),
  slippageBps: z.number().int().min(10).max(500).default(100),
});
export async function quoteTrade(mint: string, userId: string, input: unknown) {
  if (config.demo || process.env.METEORA_TRADING_ENABLED !== 'true')
    throw new HttpError(503, 'Trading is not enabled.');
  const args = quoteInput.parse(input),
    launch = await tradableLaunch(mint),
    rpc = meteoraConnection();
  await assertMeteoraNetwork(rpc);
  const wallet = await db.walletIdentity.findUnique({ where: { userId } });
  if (!wallet) throw new HttpError(403, 'Connect wallet to trade.');
  let units: bigint;
  try {
    units = parseUnits(args.amount, args.side === 'BUY' ? 9 : 6);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const phase = await refreshLaunchState(launch, rpc);
  if (phase.phase === 'MIGRATING')
    throw new HttpError(409, 'Graduation is in progress. Trading resumes when liquidity is ready.');
  const owner = new PublicKey(wallet.address),
    base = new PublicKey(mint),
    inAmount = new BN(units.toString());
  let output: BN, minimum: BN, fee: BN, impact: string, transaction;
  if (phase.phase === 'BONDING') {
    const dbc = new DynamicBondingCurveClient(rpc, 'finalized');
    const virtualPool = await dbc.state.getPool(new PublicKey(launch.poolAddress!));
    const cfg = await dbc.state.getPoolConfig(new PublicKey(launch.poolConfigAddress!));
    if (!virtualPool || !cfg) throw new HttpError(503, 'Pool state unavailable.');
    const quote = dbc.pool.swapQuote({
      virtualPool,
      config: cfg,
      swapBaseForQuote: args.side === 'SELL',
      amountIn: inAmount,
      slippageBps: args.slippageBps,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(Math.floor(Date.now() / 1000)),
    });
    if (!quote.actualInputAmount.eq(inAmount))
      throw new HttpError(409, 'Trade exceeds remaining curve capacity. Use a smaller amount.');
    output = quote.outputAmount;
    minimum = quote.minimumAmountOut;
    fee = quote.tradingFee.add(quote.protocolFee);
    const before = getPriceFromSqrtPrice(virtualPool.poolState.sqrtPrice, 6, 9);
    const effective =
      args.side === 'BUY'
        ? Number(args.amount) / (Number(output.toString()) / 1e6)
        : Number(output.toString()) / 1e9 / Number(args.amount);
    impact = before.isZero() ? '0' : before.sub(effective).abs().div(before).mul(100).toFixed(2);
    transaction = await dbc.pool.swap({
      owner,
      payer: owner,
      pool: new PublicKey(launch.poolAddress!),
      amountIn: inAmount,
      minimumAmountOut: minimum,
      swapBaseForQuote: args.side === 'SELL',
      referralTokenAccount: null,
    });
  } else {
    const cp = new CpAmm(rpc),
      updated = await db.tokenLaunch.findUniqueOrThrow({ where: { id: launch.id } });
    const poolKey = new PublicKey(updated.dammPoolAddress!),
      state = await cp.fetchPoolState(poolKey);
    const quote = cp.getQuote({
      inAmount,
      inputTokenMint: args.side === 'BUY' ? NATIVE_MINT : base,
      slippage: args.slippageBps / 100,
      poolState: state,
      currentTime: Math.floor(Date.now() / 1000),
      currentSlot: await rpc.getSlot('finalized'),
      tokenADecimal: 6,
      tokenBDecimal: 9,
      hasReferral: false,
    });
    if (!quote.consumedInAmount.eq(inAmount))
      throw new HttpError(409, 'Use a smaller trade amount.');
    output = quote.swapOutAmount;
    minimum = quote.minSwapOutAmount;
    fee = quote.totalFee;
    impact = quote.priceImpact.toFixed(2);
    transaction = await cp.swap({
      payer: owner,
      pool: poolKey,
      inputTokenMint: args.side === 'BUY' ? NATIVE_MINT : base,
      outputTokenMint: args.side === 'BUY' ? base : NATIVE_MINT,
      amountIn: inAmount,
      minimumAmountOut: minimum,
      tokenAMint: state.tokenAMint,
      tokenBMint: state.tokenBMint,
      tokenAVault: state.tokenAVault,
      tokenBVault: state.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
      poolState: state,
    });
  }
  if (output.isZero() || minimum.isZero()) throw new HttpError(400, 'Trade amount is too small.');
  const ata = getAssociatedTokenAddressSync(base, owner);
  const solBalance = await rpc.getBalance(owner, 'finalized');
  const tokenBalance = (await rpc.getAccountInfo(ata, 'finalized'))
    ? (await rpc.getTokenAccountBalance(ata, 'finalized')).value.amount
    : '0';
  if (args.side === 'SELL' && BigInt(tokenBalance) < units)
    throw new HttpError(409, 'Insufficient token balance.');
  if (args.side === 'BUY' && BigInt(solBalance) < units + 3_000_000n)
    throw new HttpError(409, 'Keep enough SOL for trade and account/network fees.');
  const quote = {
    side: args.side,
    amountUnits: units.toString(),
    outputUnits: output.toString(),
    minimumOutputUnits: minimum.toString(),
    feeUnits: fee.toString(),
    feeAsset: 'SOL',
    priceImpactPercent: impact,
    phase: phase.phase,
    slippageBps: args.slippageBps,
    solBalanceUnits: solBalance.toString(),
    tokenBalanceUnits: tokenBalance,
  };
  const step = await prepareStep(
    rpc,
    launch.id,
    `trade:${randomUUID()}`,
    'TRADE',
    `${args.side === 'BUY' ? 'Buy' : 'Sell'} ${launch.symbol}`,
    owner,
    transaction,
    [],
    quote,
  );
  return {
    ...quote,
    id: step.id,
    transaction: step.transaction,
    expiresAt: step.expiresAt!.toISOString(),
    network: launch.network,
  };
}
export async function submitTrade(mint: string, userId: string, stepId: string, raw: string) {
  const launch = await tradableLaunch(mint),
    wallet = await db.walletIdentity.findUniqueOrThrow({ where: { userId } });
  const step = await db.launchStep.findUnique({ where: { id: stepId } });
  if (
    !step ||
    step.launchId !== launch.id ||
    !['TRADE', 'CREATOR_CLAIM'].includes(step.kind) ||
    step.payer !== wallet.address
  )
    throw new HttpError(404, 'Transaction not found.');
  if (
    step.kind === 'TRADE' &&
    step.status === 'PLANNED' &&
    (config.demo || process.env.METEORA_TRADING_ENABLED !== 'true')
  )
    throw new HttpError(503, 'Trading is not enabled.');
  const rpc = meteoraConnection();
  await assertMeteoraNetwork(rpc);
  return publicTradeStep(await submitStep(rpc, stepId, raw, wallet.address));
}
export async function tradeStatus(mint: string, userId: string, stepId: string) {
  const launch = await tradableLaunch(mint),
    wallet = await db.walletIdentity.findUniqueOrThrow({ where: { userId } });
  const step = await db.launchStep.findUnique({ where: { id: stepId } });
  if (
    !step ||
    step.launchId !== launch.id ||
    step.payer !== wallet.address ||
    !['TRADE', 'CREATOR_CLAIM'].includes(step.kind)
  )
    throw new HttpError(404, 'Transaction not found.');
  const rpc = meteoraConnection();
  await assertMeteoraNetwork(rpc);
  return publicTradeStep(await rebroadcastStep(rpc, stepId));
}
function publicTradeStep(step: {
  id: string;
  status: string;
  signature: string | null;
  error: string | null;
}) {
  return { id: step.id, status: step.status, signature: step.signature, error: step.error };
}
export async function prepareCreatorClaim(mint: string, userId: string) {
  const launch = await tradableLaunch(mint),
    wallet = await db.walletIdentity.findUniqueOrThrow({ where: { userId } });
  if (launch.userId !== userId || launch.creatorAddress !== wallet.address)
    throw new HttpError(403, 'Original creator wallet required.');
  const rpc = meteoraConnection();
  await assertMeteoraNetwork(rpc);
  await refreshLaunchState(launch, rpc);
  const dfs = new DynamicFeeSharingClient(rpc, 'finalized');
  const pending = await db.launchStep.findFirst({
    where: { launchId: launch.id, kind: 'CREATOR_CLAIM', status: 'SUBMITTED' },
  });
  if (pending) return publicTradeStep(await rebroadcastStep(rpc, pending.id));
  const owner = new PublicKey(wallet.address);
  const transaction = await dfs.claimUserFee({
    feeVault: new PublicKey(launch.feeVaultAddress!),
    user: owner,
    payer: owner,
  });
  const step = await prepareStep(
    rpc,
    launch.id,
    `creator-claim:${randomUUID()}`,
    'CREATOR_CLAIM',
    'Claim creator fees',
    owner,
    transaction,
  );
  return {
    id: step.id,
    status: step.status,
    transaction: step.transaction,
    network: launch.network,
  };
}
