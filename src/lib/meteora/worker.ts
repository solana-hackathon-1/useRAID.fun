import { randomUUID } from 'node:crypto';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import type { Connection, ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { DynamicFeeSharingClient } from '@meteora-ag/dynamic-fee-sharing-sdk';
import type { TokenLaunch, LaunchStep, LaunchCampaignPayout } from '@prisma/client';
import bs58 from 'bs58';
import { db } from '../db';
import { config, trackingSettlementEnabled } from '../config';
import { decryptSecret } from '../launch-crypto';
import {
  meteoraNetwork,
  meteoraConnection,
  assertMeteoraNetwork,
  meteoraReadiness,
} from './config';
import { parseUnits, SOL_ASSET, RESERVE_UNITS, TOTAL_SUPPLY_UNITS } from './amounts';
import { prepareStep, submitStep, rebroadcastStep } from './transactions';
import { refreshLaunchState } from './state';
import { launchBalance, lockLaunchBalance } from './campaigns';
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
function operator() {
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.METEORA_OPERATOR_SECRET_KEY || ''));
  if (wallet.publicKey.toBase58() !== process.env.METEORA_OPERATOR_PUBLIC_KEY)
    throw new Error('Worker wallet does not match configured public key.');
  return wallet;
}
async function execute(
  rpc: Connection,
  launch: TokenLaunch,
  key: string,
  label: string,
  build: () => Promise<{ transaction: Transaction; signers?: Keypair[] }>,
  kind = 'WORKER',
  metadata?: object,
) {
  let step = await db.launchStep.findUnique({
    where: { launchId_key: { launchId: launch.id, key } },
  });
  if (step && ['SUBMITTED', 'CONFIRMED'].includes(step.status))
    return rebroadcastStep(rpc, step.id);
  const op = operator(),
    built = await build();
  // DFS uses its funding signer as the payer for ATA creation. Reward funds must
  // never cover this rent, even though the operator pays the transaction fee.
  for (const instruction of built.transaction.instructions) {
    if (!instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;
    if (!instruction.keys[0]?.isSigner || !instruction.keys[0].isWritable)
      throw new Error('Invalid associated-account payer.');
    instruction.keys[0] = { ...instruction.keys[0], pubkey: op.publicKey };
  }
  step = await prepareStep(
    rpc,
    launch.id,
    key,
    kind,
    label,
    op.publicKey,
    built.transaction,
    built.signers || [],
    metadata,
  );
  if (['SUBMITTED', 'CONFIRMED'].includes(step.status)) return rebroadcastStep(rpc, step.id);
  const transaction = Transaction.from(Buffer.from(step.transaction!, 'base64'));
  const required = new Set(
    transaction
      .compileMessage()
      .accountKeys.slice(0, transaction.compileMessage().header.numRequiredSignatures)
      .map((k) => k.toBase58()),
  );
  transaction.partialSign(
    ...[op, ...(built.signers || [])].filter((s) => required.has(s.publicKey.toBase58())),
  );
  return submitStep(
    rpc,
    step.id,
    transaction.serialize().toString('base64'),
    op.publicKey.toBase58(),
  );
}
async function applyCredits(launch: TokenLaunch, rpc: Connection, step: LaunchStep) {
  if (step.status !== 'CONFIRMED' || !step.signature) return;
  if (step.key.startsWith('campaign-claim:')) {
    const fees = await new DynamicFeeSharingClient(rpc, 'finalized').getFeeBreakdown(
      new PublicKey(launch.feeVaultAddress!),
    );
    const claimed = BigInt(
      fees.userFees.find((f) => f.address.toBase58() === launch.feeAddress)!.feeClaimed.toString(),
    );
    await db.$transaction(async (tx) => {
      await lockLaunchBalance(tx, launch.id);
      const total = await tx.launchBalanceEntry.aggregate({
        where: {
          launchId: launch.id,
          network: launch.network,
          kind: 'FEE_RECEIPT',
          asset: SOL_ASSET,
        },
        _sum: { availableDelta: true },
      });
      const credited = total._sum.availableDelta || 0n;
      if (claimed < credited) throw new Error('Claimed fees are below recorded campaign receipts.');
      if (claimed > credited)
        await tx.launchBalanceEntry.create({
          data: {
            key: `fee-credit:${launch.id}:${claimed}`,
            launchId: launch.id,
            network: launch.network,
            asset: SOL_ASSET,
            kind: 'FEE_RECEIPT',
            availableDelta: claimed - credited,
            reservedDelta: 0n,
            signature: step.signature,
          },
        });
    });
  }
  if (step.key === 'reserve-withdrawal') {
    const receipt = await rpc.getParsedTransaction(step.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    const units = await reserveReceiptUnits(launch, receipt, rpc);
    if (units === null) throw new Error('Reserve withdrawal receipt does not match launch.');
    await creditReserve(launch, step.signature, units);
  }
}
async function reserveReceiptUnits(
  launch: TokenLaunch,
  receipt: ParsedTransactionWithMeta | null,
  rpc: Connection,
): Promise<bigint | null> {
  if (!receipt?.meta || receipt.meta.err) return null;
  const destination = getAssociatedTokenAddressSync(
    new PublicKey(launch.mint),
    new PublicKey(launch.feeAddress),
  );
  const discriminator = Buffer.from(
    DynamicBondingCurveIdl.instructions.find((i) => i.name === 'withdraw_leftover')!.discriminator,
  );
  const instructions = [
    ...receipt.transaction.message.instructions,
    ...(receipt.meta.innerInstructions || []).flatMap((i) => i.instructions),
  ];
  for (const instruction of instructions) {
    if (!instruction.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) || !('data' in instruction))
      continue;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(bs58.decode(instruction.data));
    } catch {
      continue;
    }
    if (
      !bytes.subarray(0, 8).equals(discriminator) ||
      instruction.accounts[1]?.toBase58() !== launch.poolConfigAddress ||
      instruction.accounts[2]?.toBase58() !== launch.poolAddress ||
      !instruction.accounts[3]?.equals(destination) ||
      instruction.accounts[5]?.toBase58() !== launch.mint ||
      instruction.accounts[6]?.toBase58() !== launch.feeAddress ||
      !instruction.accounts[7]?.equals(TOKEN_PROGRAM_ID)
    )
      continue;
    const destinationIndex = receipt.transaction.message.accountKeys.findIndex((k) =>
      k.pubkey.equals(destination),
    );
    const sourceIndex = receipt.transaction.message.accountKeys.findIndex((k) =>
      k.pubkey.equals(instruction.accounts[4]),
    );
    const pre = receipt.meta.preTokenBalances?.find(
      (t) => t.accountIndex === destinationIndex && t.mint === launch.mint,
    );
    const post = receipt.meta.postTokenBalances?.find(
      (t) =>
        t.accountIndex === destinationIndex &&
        t.mint === launch.mint &&
        t.owner === launch.feeAddress,
    );
    const sourcePre = receipt.meta.preTokenBalances?.find(
      (t) => t.accountIndex === sourceIndex && t.mint === launch.mint,
    );
    const sourcePost = receipt.meta.postTokenBalances?.find(
      (t) => t.accountIndex === sourceIndex && t.mint === launch.mint,
    );
    if (!post || !sourcePre) return null;
    const units = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount || '0');
    const withdrawn =
      BigInt(sourcePre.uiTokenAmount.amount) - BigInt(sourcePost?.uiTokenAmount.amount || '0');
    const cfg = await new DynamicBondingCurveClient(rpc, 'finalized').state.getPoolConfig(
      new PublicKey(launch.poolConfigAddress!),
    );
    if (!cfg) return null;
    // Curve math rounds in base units; its legitimate remainder can exceed nominal 50M slightly.
    const actualReserve =
      TOTAL_SUPPLY_UNITS -
      BigInt(cfg.swapBaseAmount.toString()) -
      BigInt(cfg.migrationBaseThreshold.toString());
    if (actualReserve < 0n || units < 0n || units > actualReserve || units !== withdrawn)
      return null;
    return units;
  }
  return null;
}
async function creditReserve(launch: TokenLaunch, signature: string, units: bigint) {
  await db.$transaction(async (tx) => {
    await lockLaunchBalance(tx, launch.id);
    if (await tx.launchBalanceEntry.findUnique({ where: { key: `reserve-credit:${launch.id}` } }))
      return;
    await tx.launchBalanceEntry.create({
      data: {
        key: `reserve-credit:${launch.id}`,
        launchId: launch.id,
        network: launch.network,
        asset: launch.mint,
        kind: 'RESERVE_RECEIPT',
        availableDelta: units,
        reservedDelta: 0n,
        signature,
      },
    });
  });
}
async function reconcileExternalReserve(launch: TokenLaunch, rpc: Connection) {
  if (await db.launchBalanceEntry.findUnique({ where: { key: `reserve-credit:${launch.id}` } }))
    return;
  const destination = getAssociatedTokenAddressSync(
    new PublicKey(launch.mint),
    new PublicKey(launch.feeAddress),
  );
  let before: string | undefined;
  for (let page = 0; page < 10; page++) {
    const signatures = await rpc.getSignaturesForAddress(
      destination,
      { limit: 100, ...(before ? { before } : {}) },
      'finalized',
    );
    for (const candidate of signatures) {
      if (candidate.err) continue;
      const receipt = await rpc.getParsedTransaction(candidate.signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      });
      const units = await reserveReceiptUnits(launch, receipt, rpc);
      if (units !== null) {
        await creditReserve(launch, candidate.signature, units);
        return;
      }
    }
    if (signatures.length < 100) break;
    before = signatures[signatures.length - 1].signature;
  }
  throw new Error(
    'Finalized external reserve withdrawal receipt unavailable; no token funds credited.',
  );
}
async function recordPayout(launch: TokenLaunch, row: LaunchCampaignPayout, step: LaunchStep) {
  if (step.status === 'SUBMITTED')
    await db.launchCampaignPayout.updateMany({
      where: { id: row.id, status: { not: 'PAID' } },
      data: { status: 'SUBMITTED', signature: step.signature },
    });
  if (step.status !== 'CONFIRMED') return;
  const metadata = step.metadata as {
    payoutId?: string;
    asset?: string;
    units?: string;
    recipient?: string;
  } | null;
  if (
    !step.signature ||
    metadata?.payoutId !== row.id ||
    metadata.asset !== row.asset ||
    metadata.units !== row.units.toString() ||
    metadata.recipient !== row.walletAddress
  )
    throw new Error('Payout transaction does not match approved allocation.');
  await db.$transaction(async (tx) => {
    await lockLaunchBalance(tx, launch.id);
    const current = await tx.launchCampaignPayout.findUniqueOrThrow({ where: { id: row.id } });
    if (current.status === 'PAID') return;
    if (
      current.units !== row.units ||
      current.walletAddress !== row.walletAddress ||
      current.asset !== row.asset ||
      current.network !== launch.network ||
      !current.approvedAt
    )
      throw new Error('Approved payout changed.');
    await tx.launchBalanceEntry.create({
      data: {
        key: `paid:${row.id}`,
        launchId: launch.id,
        raidId: row.raidId,
        network: launch.network,
        asset: row.asset,
        kind: 'PAID',
        availableDelta: 0n,
        reservedDelta: -row.units,
        signature: step.signature,
      },
    });
    await tx.launchCampaignBudget.update({
      where: { raidId_asset: { raidId: row.raidId, asset: row.asset } },
      data: { paidUnits: { increment: row.units } },
    });
    await tx.launchCampaignPayout.update({
      where: { id: row.id },
      data: { status: 'PAID', signature: step.signature, paidAt: new Date() },
    });
  });
}
function workerActionsReady() {
  // Turning off new launches or metadata uploads must not disable rewards. Image verification is a web-only key.
  return !meteoraReadiness().issues.some(
    (issue) =>
      ![
        'Token launches are not enabled yet.',
        'Token image storage needs configuration.',
        'Launch image verification needs configuration.',
      ].includes(issue),
  );
}
async function verifyLiabilities(launch: TokenLaunch, rpc: Connection, campaign: Keypair) {
  for (const asset of [SOL_ASSET, launch.mint]) {
    const balance = await launchBalance(launch.id, asset),
      liabilities = balance.available + balance.reserved;
    const held =
      asset === SOL_ASSET
        ? BigInt(await rpc.getBalance(campaign.publicKey, 'finalized'))
        : (await rpc.getAccountInfo(
              getAssociatedTokenAddressSync(new PublicKey(launch.mint), campaign.publicKey),
              'finalized',
            ))
          ? (
              await getAccount(
                rpc,
                getAssociatedTokenAddressSync(new PublicKey(launch.mint), campaign.publicKey),
                'finalized',
              )
            ).amount
          : 0n;
    if (balance.available < 0n || balance.reserved < 0n || held < liabilities) {
      await db.tokenLaunch.update({
        where: { id: launch.id },
        data: {
          status: 'PAUSED',
          error: 'Campaign wallet balance does not cover recorded liabilities.',
        },
      });
      throw new Error('Campaign wallet accounting mismatch.');
    }
  }
}
async function payout(launch: TokenLaunch, rpc: Connection, campaign: Keypair) {
  const rows = await db.launchCampaignPayout.findMany({
    where: {
      launchId: launch.id,
      network: launch.network,
      status: { in: ['APPROVED', 'SUBMITTED'] },
    },
    orderBy: { id: 'asc' },
    take: 10,
  });
  for (const row of rows) {
    const old = await db.launchStep.findUnique({
      where: { launchId_key: { launchId: launch.id, key: `payout:${row.id}` } },
    });
    if (old && ['SUBMITTED', 'CONFIRMED'].includes(old.status)) {
      const reconciled = await rebroadcastStep(rpc, old.id);
      await recordPayout(launch, row, reconciled);
      if (reconciled.status === 'SUBMITTED') return true;
      continue;
    }
    const currentLaunch = await db.tokenLaunch.findUniqueOrThrow({
      where: { id: launch.id },
      include: { user: true },
    });
    const settings = await db.settings.findUnique({ where: { id: 'global' } });
    if (
      currentLaunch.status !== 'LIVE' ||
      currentLaunch.user.suspended ||
      !workerActionsReady() ||
      settings?.payoutPaused ||
      !settings?.collectionEnabled ||
      !trackingSettlementEnabled() ||
      !config.liveApproved ||
      process.env.METEORA_PAYOUT_ENABLED !== 'true'
    )
      continue;
    if (!row.approvedAt || row.units <= 0n || ![SOL_ASSET, launch.mint].includes(row.asset))
      throw new Error('Invalid approved campaign payout.');
    await refreshLaunchState(currentLaunch, rpc);
    await verifyLiabilities(currentLaunch, rpc, campaign);
    const max =
      launch.network === 'mainnet'
        ? parseUnits(
            process.env[
              row.asset === SOL_ASSET ? 'METEORA_MAX_PAYOUT_SOL' : 'METEORA_MAX_PAYOUT_TOKENS'
            ] || '0',
            row.asset === SOL_ASSET ? 9 : 6,
          )
        : row.asset === SOL_ASSET
          ? 1_000_000_000n
          : RESERVE_UNITS;
    if (row.units > max) {
      await db.launchCampaignPayout.update({ where: { id: row.id }, data: { status: 'HELD' } });
      continue;
    }
    const target = new PublicKey(row.walletAddress);
    const step = await execute(
      rpc,
      launch,
      `payout:${row.id}`,
      `Pay reviewed ${row.asset === SOL_ASSET ? 'SOL' : 'token'} reward`,
      async () => {
        const transaction = new Transaction();
        if (row.asset === SOL_ASSET)
          transaction.add(
            SystemProgram.transfer({
              fromPubkey: campaign.publicKey,
              toPubkey: target,
              lamports: row.units,
            }),
          );
        else {
          if (row.asset !== launch.mint) throw new Error('Payout token does not match launch.');
          const mint = new PublicKey(launch.mint),
            source = getAssociatedTokenAddressSync(mint, campaign.publicKey),
            destination = getAssociatedTokenAddressSync(mint, target);
          transaction.add(
            createAssociatedTokenAccountIdempotentInstruction(
              operator().publicKey,
              destination,
              target,
              mint,
            ),
            createTransferCheckedInstruction(
              source,
              mint,
              destination,
              campaign.publicKey,
              row.units,
              6,
            ),
          );
        }
        transaction.add(
          new TransactionInstruction({
            programId: MEMO_PROGRAM,
            keys: [],
            data: Buffer.from(`useRAID:meteora:pay:${row.id}`),
          }),
        );
        return { transaction, signers: [campaign] };
      },
      'PAYOUT',
      {
        payoutId: row.id,
        asset: row.asset,
        units: row.units.toString(),
        recipient: row.walletAddress,
      },
    );
    await recordPayout(launch, row, step);
    // Until the receipt is final, don't compare transferred balances to ledger
    // liabilities or submit more payments against an uncertain balance.
    if (step.status === 'SUBMITTED') return true;
  }
  return false;
}
export async function financeMeteoraLaunch(id: string) {
  let launch = await db.tokenLaunch.findUniqueOrThrow({ where: { id }, include: { user: true } });
  if (launch.provider !== 'METEORA' || launch.network !== meteoraNetwork()) return;
  const rpc = meteoraConnection();
  await assertMeteoraNetwork(rpc);
  // Always reconcile previously signed transactions, including while switches are paused.
  const pending = await db.launchStep.findMany({
    where: {
      launchId: id,
      kind: { in: ['WORKER', 'PAYOUT'] },
      status: { in: ['SUBMITTED', 'CONFIRMED'] },
    },
  });
  let pendingPayment = false;
  for (const previous of pending.filter((step) => step.kind === 'PAYOUT')) {
    const reconciled = await rebroadcastStep(rpc, previous.id);
    const row = await db.launchCampaignPayout.findUniqueOrThrow({
      where: { id: previous.key.slice('payout:'.length) },
    });
    await recordPayout(launch, row, reconciled);
    if (reconciled.status === 'SUBMITTED') pendingPayment = true;
  }
  for (const previous of pending.filter((step) => step.kind !== 'PAYOUT'))
    await applyCredits(launch, rpc, await rebroadcastStep(rpc, previous.id));
  if (pendingPayment) return;
  launch = await db.tokenLaunch.findUniqueOrThrow({ where: { id }, include: { user: true } });
  if (launch.status !== 'LIVE' || launch.user.suspended || !workerActionsReady()) return;
  const campaign = Keypair.fromSecretKey(
    decryptSecret(launch.feeSecret, `meteora-campaign:${launch.mint}`),
  );
  if (campaign.publicKey.toBase58() !== launch.feeAddress)
    throw new Error('Campaign wallet mismatch.');
  const snapshot = await refreshLaunchState(launch, rpc);
  if (snapshot.reserveWithdrawn) await reconcileExternalReserve(launch, rpc);
  await verifyLiabilities(launch, rpc, campaign);
  launch = await db.tokenLaunch.findUniqueOrThrow({ where: { id }, include: { user: true } });
  const op = operator(),
    dbc = new DynamicBondingCurveClient(rpc, 'finalized'),
    dfs = new DynamicFeeSharingClient(rpc, 'finalized');
  if ((await rpc.getBalance(op.publicKey, 'finalized')) < 50_000_000)
    throw new Error('Worker needs at least 0.05 SOL for network costs.');
  if (await payout(launch, rpc, campaign)) return;
  if (snapshot.phase === 'MIGRATING' && process.env.METEORA_COLLECTION_ENABLED === 'true') {
    const migration = await execute(rpc, launch, 'migrate', 'Graduate to DAMM v2', async () => {
      const result = await dbc.migration.migrateToDammV2({
        payer: op.publicKey,
        pool: new PublicKey(launch.poolAddress!),
        dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[6],
      });
      return {
        transaction: result.transaction,
        signers: [result.firstPositionNftKeypair, result.secondPositionNftKeypair],
      };
    });
    if (migration.status !== 'CONFIRMED') return;
    await refreshLaunchState(launch, rpc);
    launch = await db.tokenLaunch.findUniqueOrThrow({ where: { id }, include: { user: true } });
  }
  const p = await dbc.state.getPool(new PublicKey(launch.poolAddress!));
  if (process.env.METEORA_COLLECTION_ENABLED === 'true') {
    if (p && !p.poolState.partnerQuoteFee.isZero()) {
      const latest = await db.launchStep.findFirst({
        where: {
          launchId: id,
          kind: 'WORKER',
          key: { startsWith: 'fund-dbc:' },
          status: 'SUBMITTED',
        },
      });
      const key = latest?.key || `fund-dbc:${randomUUID()}`;
      await execute(rpc, launch, key, 'Collect bonding curve fees', async () => ({
        transaction: await dfs.fundByClaimDbcPartnerTradingFee2({
          signer: campaign.publicKey,
          feeClaimer: new PublicKey(launch.feeVaultAddress!),
          feeVault: new PublicKey(launch.feeVaultAddress!),
          poolConfig: new PublicKey(launch.poolConfigAddress!),
          virtualPool: new PublicKey(launch.poolAddress!),
        }),
        signers: [campaign],
      }));
    }
    if (launch.migrationStatus === 'GRADUATED') {
      const pendingFund = await db.launchStep.findFirst({
        where: { launchId: id, key: { startsWith: 'fund-damm:' }, status: 'SUBMITTED' },
      });
      await execute(
        rpc,
        launch,
        pendingFund?.key || `fund-damm:${Math.floor(Date.now() / 300000)}`,
        'Collect locked liquidity trading fees',
        async () => ({
          transaction: await dfs.fundByClaimDammV2Fee({
            signer: campaign.publicKey,
            owner: new PublicKey((launch.configuration as { vaultBase: string }).vaultBase),
            feeVault: new PublicKey(launch.feeVaultAddress!),
            dammV2Pool: new PublicKey(launch.dammPoolAddress!),
            dammV2Position: new PublicKey(launch.positionAddress!),
            dammV2PositionNftAccount: new PublicKey(launch.positionNftAccount!),
          }),
          signers: [campaign],
        }),
      );
      if (p && !p.poolState.isWithdrawLeftover) {
        const reserve = await execute(
          rpc,
          launch,
          'reserve-withdrawal',
          'Release campaign token reserve',
          async () => ({
            transaction: await dbc.migration.withdrawLeftover({
              payer: op.publicKey,
              pool: new PublicKey(launch.poolAddress!),
            }),
          }),
        );
        await applyCredits(launch, rpc, reserve);
      }
    }
    const fees = await dfs.getFeeBreakdown(new PublicKey(launch.feeVaultAddress!));
    const available = fees.userFees.find((f) => f.address.toBase58() === launch.feeAddress)!;
    if (!available.feeUnclaimed.isZero()) {
      if (launch.network === 'mainnet') {
        const balance = await launchBalance(id, SOL_ASSET),
          limit = parseUnits(process.env.METEORA_MAX_CUSTODY_SOL || '0', 9);
        if (
          balance.available + balance.reserved + BigInt(available.feeUnclaimed.toString()) >
          limit
        )
          throw new Error('Campaign custody exposure limit reached.');
      }
      const claim = await execute(
        rpc,
        launch,
        `campaign-claim:${available.totalFee}`,
        'Claim community fees into campaign balance',
        async () => ({
          transaction: await dfs.claimUserFee({
            feeVault: new PublicKey(launch.feeVaultAddress!),
            user: campaign.publicKey,
            payer: op.publicKey,
          }),
          signers: [campaign],
        }),
      );
      await applyCredits(launch, rpc, claim);
    }
  }
  await verifyLiabilities(launch, rpc, campaign);
  await db.tokenLaunch.update({
    where: { id },
    data: { workerObservedAt: new Date(), error: null },
  });
  await refreshLaunchState(launch, rpc);
}
