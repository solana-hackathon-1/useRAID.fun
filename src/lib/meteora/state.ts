import type { TokenLaunch } from '@prisma/client';
import type { Connection, VersionedTransactionResponse } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { getMint, getAccount, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveMintMetadata,
  deriveDammV2PoolAddress,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  getPriceFromSqrtPrice,
  METAPLEX_PROGRAM_ID,
  getMigrationThresholdPrice,
  getMigrationBaseToken,
  getBaseTokenForSwap,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  CpAmm,
  derivePositionAddress,
  derivePositionNftAccount,
  decodePodAlignedFeeTimeScheduler,
  bpsToFeeNumerator,
} from '@meteora-ag/cp-amm-sdk';
import { DynamicFeeSharingClient } from '@meteora-ag/dynamic-fee-sharing-sdk';
import bs58 from 'bs58';
import { db } from '../db';
import { HttpError } from '../auth-primitives';
import { assertMeteoraNetwork } from './config';
import { buildLaunchCurve } from './template';
import { TOTAL_SUPPLY_UNITS } from './amounts';
export interface LaunchChainSnapshot {
  phase: 'BONDING' | 'MIGRATING' | 'GRADUATED';
  priceSol: string;
  progress: number;
  quoteReserveUnits: string;
  graduationUnits: string;
  reserveWithdrawn: boolean;
  authoritiesVerified: boolean;
  liquidityLockedVerified: boolean;
  totalDistributableFeeUnits: string;
  creatorAllocatedUnits: string;
  creatorClaimedUnits: string;
  creatorClaimableUnits: string;
  campaignAllocatedUnits: string;
  campaignClaimedUnits: string;
  currentSupplyUnits: string;
  burnedUnits: string;
  actualCurveSaleUnits: string;
  actualMigrationBaseUnits: string;
  actualReserveUnits: string;
  migrationSignature?: string;
  migrationPositionNftMint?: string;
}
const migrationInstruction = DynamicBondingCurveIdl.instructions.find(
  (i) => i.name === 'migration_damm_v2',
)!;
const migrationDiscriminator = Buffer.from(migrationInstruction.discriminator);
export function migrationPositionFromReceipt(
  receipt: VersionedTransactionResponse,
  launch: TokenLaunch,
  dammPool: PublicKey,
) {
  if (!receipt.meta || receipt.meta.err) return null;
  const keys = [
    ...receipt.transaction.message.staticAccountKeys,
    ...(receipt.meta.loadedAddresses?.writable || []),
    ...(receipt.meta.loadedAddresses?.readonly || []),
  ];
  const instructions = [
    ...receipt.transaction.message.compiledInstructions,
    ...(receipt.meta.innerInstructions?.flatMap((group) =>
      group.instructions.map((i) => ({
        programIdIndex: i.programIdIndex,
        accountKeyIndexes: i.accounts,
        data: bs58.decode(i.data),
      })),
    ) || []),
  ];
  for (const instruction of instructions) {
    if (
      !keys[instruction.programIdIndex]?.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ||
      !Buffer.from(instruction.data).equals(migrationDiscriminator)
    )
      continue;
    const account = (name: string) =>
      keys[
        instruction.accountKeyIndexes[
          migrationInstruction.accounts.findIndex((a) => a.name === name)
        ]
      ];
    if (
      account('virtual_pool')?.toBase58() !== launch.poolAddress ||
      account('config')?.toBase58() !== launch.poolConfigAddress ||
      !account('pool')?.equals(dammPool) ||
      account('base_mint')?.toBase58() !== launch.mint ||
      !account('quote_mint')?.equals(NATIVE_MINT)
    )
      continue;
    const nftMint = account('first_position_nft_mint');
    if (
      !nftMint ||
      !account('first_position')?.equals(derivePositionAddress(nftMint)) ||
      !account('first_position_nft_account')?.equals(derivePositionNftAccount(nftMint))
    )
      continue;
    return {
      nftMint,
      position: derivePositionAddress(nftMint),
      nftAccount: derivePositionNftAccount(nftMint),
    };
  }
  return null;
}
async function findMigrationPosition(
  launch: TokenLaunch,
  rpc: Connection,
  dammPool: PublicKey,
  activationTimestamp: number,
) {
  const saved = launch.chainSnapshot as Partial<LaunchChainSnapshot> | null;
  // Only cache identities previously proved by a finalized migration receipt, never by owner scans.
  if (saved?.migrationSignature && saved.migrationPositionNftMint) {
    const nftMint = new PublicKey(saved.migrationPositionNftMint);
    return {
      nftMint,
      position: derivePositionAddress(nftMint),
      nftAccount: derivePositionNftAccount(nftMint),
      signature: saved.migrationSignature,
    };
  }
  const ownMigration = await db.launchStep.findFirst({
    where: { launchId: launch.id, key: 'migrate', signature: { not: null } },
  });
  if (ownMigration?.signature) {
    const receipt = await rpc.getTransaction(ownMigration.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    const position = receipt && migrationPositionFromReceipt(receipt, launch, dammPool);
    if (position) return { ...position, signature: ownMigration.signature };
  }
  // External keepers are permissionless. Locate their original migration through DBC history.
  // Reading the DBC address avoids scanning every post-graduation DAMM trade.
  let before: string | undefined;
  for (let page = 0; page < 20; page++) {
    const signatures = await rpc.getSignaturesForAddress(
      new PublicKey(launch.poolAddress!),
      { before, limit: 1000 },
      'finalized',
    );
    for (const item of signatures) {
      if (item.err || (item.blockTime && item.blockTime > activationTimestamp + 30)) continue;
      const receipt = await rpc.getTransaction(item.signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      const position = receipt && migrationPositionFromReceipt(receipt, launch, dammPool);
      if (position) return { ...position, signature: item.signature };
    }
    if (signatures.length < 1000) break;
    before = signatures.at(-1)!.signature;
  }
  throw new HttpError(
    503,
    'Finalized migration receipt is unavailable. An archive RPC is required to verify liquidity.',
  );
}
export function metadataImmutable(data: Buffer) {
  // Metaplex Metadata v1: fixed header, three Borsh strings, fees, optional creators, flags.
  try {
    let offset = 65;
    for (let n = 0; n < 3; n++) {
      const length = data.readUInt32LE(offset);
      offset += 4 + length;
      if (offset > data.length) return false;
    }
    offset += 2;
    const creators = data[offset++];
    if (creators === 1) {
      const count = data.readUInt32LE(offset);
      offset += 4 + count * 34;
    } else if (creators !== 0) return false;
    return offset + 1 < data.length && data[offset + 1] === 0;
  } catch {
    return false;
  }
}
export async function verifyLaunchChain(launch: TokenLaunch, rpc: Connection) {
  await assertMeteoraNetwork(rpc, launch.network as 'devnet' | 'mainnet');
  const dbc = new DynamicBondingCurveClient(rpc, 'finalized'),
    dfs = new DynamicFeeSharingClient(rpc, 'finalized');
  const pool = await dbc.state.getPool(new PublicKey(launch.poolAddress!));
  const cfg = await dbc.state.getPoolConfig(new PublicKey(launch.poolConfigAddress!));
  if (!pool || !cfg) throw new HttpError(409, 'Launch accounts are not finalized yet.');
  const p = pool.poolState,
    expected = buildLaunchCurve(launch.network as 'devnet' | 'mainnet');
  const migrationSqrtPrice = getMigrationThresholdPrice(
    expected.migrationQuoteThreshold,
    expected.sqrtStartPrice,
    expected.curve,
  );
  const expectedSwap = getBaseTokenForSwap(
    expected.sqrtStartPrice,
    migrationSqrtPrice,
    expected.curve,
  );
  const expectedMigration = getMigrationBaseToken(
    expected.migrationQuoteThreshold,
    migrationSqrtPrice,
    1,
  );
  const actualReserve =
    TOTAL_SUPPLY_UNITS - BigInt(expectedSwap.toString()) - BigInt(expectedMigration.toString());
  const mint = await getMint(rpc, new PublicKey(launch.mint), 'finalized');
  const vault = await dfs.getFeeVault(new PublicKey(launch.feeVaultAddress!));
  const metadata = await rpc.getAccountInfo(
    deriveMintMetadata(new PublicKey(launch.mint)),
    'finalized',
  );
  const shares = vault.users.filter((u) => !u.address.equals(PublicKey.default));
  const correct =
    p.config.toBase58() === launch.poolConfigAddress &&
    p.baseMint.toBase58() === launch.mint &&
    p.creator.toBase58() === launch.creatorAddress &&
    cfg.feeClaimer.toBase58() === launch.feeVaultAddress &&
    cfg.leftoverReceiver.toBase58() === launch.feeAddress &&
    cfg.quoteMint.equals(NATIVE_MINT) &&
    cfg.tokenDecimal === 6 &&
    cfg.tokenType === 0 &&
    cfg.fixedTokenSupplyFlag === 1 &&
    cfg.preMigrationTokenSupply.toString() === TOTAL_SUPPLY_UNITS.toString() &&
    cfg.postMigrationTokenSupply.toString() === TOTAL_SUPPLY_UNITS.toString() &&
    cfg.tokenUpdateAuthority === 1 &&
    cfg.creatorTradingFeePercentage === 0 &&
    cfg.collectFeeMode === 0 &&
    cfg.activationType === 1 &&
    cfg.migrationFeeOption === 6 &&
    cfg.migrationFeePercentage === 0 &&
    cfg.creatorMigrationFeePercentage === 0 &&
    cfg.poolCreationFee.isZero() &&
    cfg.enableFirstSwapWithMinFee === 0 &&
    cfg.poolFees.dynamicFee.initialized === 0 &&
    cfg.partnerPermanentLockedLiquidityPercentage === 100 &&
    cfg.partnerLiquidityPercentage === 0 &&
    cfg.creatorLiquidityPercentage === 0 &&
    cfg.creatorPermanentLockedLiquidityPercentage === 0 &&
    cfg.migrationOption === 1 &&
    cfg.migrationQuoteThreshold.eq(expected.migrationQuoteThreshold) &&
    cfg.sqrtStartPrice.eq(expected.sqrtStartPrice) &&
    cfg.poolFees.baseFee.cliffFeeNumerator.eq(expected.poolFees.baseFee.cliffFeeNumerator) &&
    cfg.poolFees.baseFee.firstFactor === 0 &&
    cfg.poolFees.baseFee.baseFeeMode === 0 &&
    cfg.poolFees.baseFee.secondFactor.isZero() &&
    cfg.poolFees.baseFee.thirdFactor.isZero() &&
    cfg.migratedPoolFeeBps === 100 &&
    cfg.migratedDynamicFee === 0 &&
    cfg.migratedCollectFeeMode === 0 &&
    cfg.migratedPoolBaseFeeMode === 0 &&
    cfg.migratedCompoundingFeeBps === 0 &&
    cfg.swapBaseAmount.eq(expectedSwap) &&
    cfg.migrationBaseThreshold.eq(expectedMigration) &&
    cfg.migrationSqrtPrice.eq(migrationSqrtPrice) &&
    actualReserve > 0n &&
    cfg.lockedVestingConfig.amountPerPeriod.isZero() &&
    cfg.lockedVestingConfig.cliffUnlockAmount.isZero() &&
    cfg.lockedVestingConfig.numberOfPeriod.isZero() &&
    cfg.partnerLiquidityVestingInfo.vestingPercentage === 0 &&
    cfg.creatorLiquidityVestingInfo.vestingPercentage === 0 &&
    cfg.curve.every((c, i) =>
      i < expected.curve.length
        ? c.sqrtPrice.eq(expected.curve[i].sqrtPrice) && c.liquidity.eq(expected.curve[i].liquidity)
        : c.sqrtPrice.isZero() && c.liquidity.isZero(),
    ) &&
    mint.decimals === 6 &&
    !mint.mintAuthority &&
    !mint.freezeAuthority &&
    mint.supply <= TOTAL_SUPPLY_UNITS &&
    vault.tokenMint.equals(NATIVE_MINT) &&
    vault.feeVaultType === 1 &&
    vault.totalShare === 100 &&
    shares.length === 2 &&
    vault.base.toBase58() === (launch.configuration as { vaultBase: string }).vaultBase &&
    vault.owner.equals(vault.base) &&
    shares.some((u) => u.address.toBase58() === launch.creatorAddress && u.share === 80) &&
    shares.some((u) => u.address.toBase58() === launch.feeAddress && u.share === 20) &&
    metadata?.owner.equals(METAPLEX_PROGRAM_ID) &&
    metadataImmutable(metadata.data);
  if (!correct) {
    await db.tokenLaunch.update({
      where: { id: launch.id },
      data: {
        status: 'PAUSED',
        error: 'Onchain launch configuration or token authority mismatch.',
      },
    });
    throw new HttpError(409, 'Launch verification failed. Operations review required.');
  }
  return { pool, cfg, mint, vault, actualReserve };
}
export async function refreshLaunchState(launch: TokenLaunch, rpc: Connection) {
  const { pool, cfg, mint, actualReserve } = await verifyLaunchChain(launch, rpc);
  const p = pool.poolState,
    dfs = new DynamicFeeSharingClient(rpc, 'finalized'),
    cp = new CpAmm(rpc);
  const fee = await dfs.getFeeBreakdown(new PublicKey(launch.feeVaultAddress!));
  const creator = fee.userFees.find((f) => f.address.toBase58() === launch.creatorAddress)!;
  const campaign = fee.userFees.find((f) => f.address.toBase58() === launch.feeAddress)!;
  let phase: LaunchChainSnapshot['phase'] = p.isMigrated
    ? 'GRADUATED'
    : p.quoteReserve.gte(cfg.migrationQuoteThreshold)
      ? 'MIGRATING'
      : 'BONDING';
  let price = getPriceFromSqrtPrice(p.sqrtPrice, 6, 9).toString(),
    locked = false;
  let positionAddress = launch.positionAddress,
    positionNftAccount = launch.positionNftAccount;
  let migrationSignature: string | undefined, migrationPositionNftMint: string | undefined;
  const dammAddress = deriveDammV2PoolAddress(
    DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption],
    new PublicKey(launch.mint),
    NATIVE_MINT,
  );
  if (phase === 'GRADUATED') {
    const state = await cp.fetchPoolState(dammAddress);
    const baseFee = decodePodAlignedFeeTimeScheduler(
      Buffer.from(state.poolFees.baseFee.baseFeeInfo.data),
    );
    if (
      !state.tokenAMint.equals(new PublicKey(launch.mint)) ||
      !state.tokenBMint.equals(NATIVE_MINT) ||
      state.collectFeeMode !== 0 ||
      state.poolFees.dynamicFee.initialized !== 0 ||
      baseFee.baseFeeMode !== 0 ||
      !baseFee.cliffFeeNumerator.eq(bpsToFeeNumerator(100)) ||
      baseFee.numberOfPeriod !== 0 ||
      !baseFee.reductionFactor.isZero() ||
      !baseFee.periodFrequency.isZero()
    )
      throw new HttpError(409, 'Graduated pool configuration mismatch.');
    price = getPriceFromSqrtPrice(state.sqrtPrice, 6, 9).toString();
    const identity = await findMigrationPosition(
      launch,
      rpc,
      dammAddress,
      state.activationPoint.toNumber(),
    );
    const position = await cp.fetchPositionState(identity.position);
    const nft = await getAccount(rpc, identity.nftAccount, 'finalized', TOKEN_2022_PROGRAM_ID);
    if (
      !position.pool.equals(dammAddress) ||
      !position.nftMint.equals(identity.nftMint) ||
      nft.amount !== 1n ||
      !nft.mint.equals(identity.nftMint) ||
      nft.owner.toBase58() !== launch.feeVaultAddress ||
      !position.unlockedLiquidity.isZero() ||
      !position.vestedLiquidity.isZero() ||
      position.permanentLockedLiquidity.isZero()
    )
      throw new HttpError(409, 'Launch liquidity lock or fee ownership verification failed.');
    locked = true;
    positionAddress = identity.position.toBase58();
    positionNftAccount = identity.nftAccount.toBase58();
    migrationSignature = identity.signature;
    migrationPositionNftMint = identity.nftMint.toBase58();
  }
  const snapshot: LaunchChainSnapshot = {
    phase,
    priceSol: price,
    progress: Math.min(
      1,
      Number(p.quoteReserve.toString()) / Number(cfg.migrationQuoteThreshold.toString()),
    ),
    quoteReserveUnits: p.quoteReserve.toString(),
    graduationUnits: cfg.migrationQuoteThreshold.toString(),
    reserveWithdrawn: !!p.isWithdrawLeftover,
    authoritiesVerified: true,
    liquidityLockedVerified: locked,
    totalDistributableFeeUnits: fee.totalFundedFee.toString(),
    creatorAllocatedUnits: creator.totalFee.toString(),
    creatorClaimedUnits: creator.feeClaimed.toString(),
    creatorClaimableUnits: creator.feeUnclaimed.toString(),
    campaignAllocatedUnits: campaign.totalFee.toString(),
    campaignClaimedUnits: campaign.feeClaimed.toString(),
    currentSupplyUnits: mint.supply.toString(),
    burnedUnits: (TOTAL_SUPPLY_UNITS - mint.supply).toString(),
    actualCurveSaleUnits: cfg.swapBaseAmount.toString(),
    actualMigrationBaseUnits: cfg.migrationBaseThreshold.toString(),
    actualReserveUnits: actualReserve.toString(),
    ...(migrationSignature ? { migrationSignature, migrationPositionNftMint } : {}),
  };
  await db.tokenLaunch.update({
    where: { id: launch.id },
    data: {
      chainSnapshot: JSON.parse(JSON.stringify(snapshot)),
      chainObservedAt: new Date(),
      migrationStatus: phase,
      dammPoolAddress: phase === 'GRADUATED' ? dammAddress.toBase58() : null,
      positionAddress,
      positionNftAccount,
    },
  });
  return snapshot;
}
