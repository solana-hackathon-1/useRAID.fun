import { trackingEnabled, trackingSettlementEnabled } from './config';
import { launchpadsAvailable } from './release';
import { lockTracking } from './tracking';
import { trackingBlockers, type ResultPayload } from './tracking-review';
import bs58 from 'bs58';
import { randomUUID } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  OnlinePumpSdk,
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  ammCreatorVaultPda,
  bondingCurvePda,
  canonicalPumpPoolPda,
  creatorVaultPda,
  getPumpAmmProgram,
} from './pump-sdk';
import type { TokenLaunch, Prisma } from '@prisma/client';
import { db } from './db';
import { config } from './config';
import { decryptSecret } from './launch-crypto';
import { connection, assertMainnet } from './pump-launch';
import { authorScores, splitRewards } from './reward-math';

const MIN_PAYOUT = 1_000_000n;
function operator() {
  const secret = process.env.OPERATOR_SECRET_KEY;
  if (!secret) throw new Error('Operator signer unavailable');
  const key = Keypair.fromSecretKey(bs58.decode(secret));
  if (key.publicKey.toBase58() !== process.env.OPERATOR_PUBLIC_KEY)
    throw new Error('Operator signer does not match public configuration');
  if (key.publicKey.equals(new PublicKey(process.env.PLATFORM_TREASURY_ADDRESS || key.publicKey)))
    throw new Error('Operator and treasury must be distinct');
  return key;
}
function feeKey(launch: TokenLaunch) {
  return Keypair.fromSecretKey(decryptSecret(launch.feeSecret, `fee:${launch.mint}`));
}
export function payoutsEnabled() {
  return (
    launchpadsAvailable &&
    !config.demo &&
    config.liveApproved &&
    process.env.PAYOUT_ENABLED === 'true' &&
    !!process.env.OPERATOR_SECRET_KEY &&
    !!process.env.OPERATOR_PUBLIC_KEY &&
    !!process.env.PLATFORM_TREASURY_ADDRESS &&
    !!process.env.SOLANA_RPC_URL
  );
}
export async function updateFinanceReadiness() {
  let address: string | null = null;
  if (payoutsEnabled()) {
    try {
      const gas = operator(),
        rpc = connection();
      await assertMainnet(rpc);
      if ((await rpc.getBalance(gas.publicKey, 'finalized')) >= 50_000_000)
        address = gas.publicKey.toBase58();
    } catch {
      address = null;
    }
  }
  await db.settings.upsert({
    where: { id: 'global' },
    create: { payoutWorkerAt: address ? new Date() : null, operatorAddress: address },
    update: { payoutWorkerAt: address ? new Date() : null, operatorAddress: address },
  });
}
async function expectedFee(
  rpc: Connection,
  payer: PublicKey,
  feeAddress: PublicKey,
  blockhash: string,
) {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({ fromPubkey: feeAddress, toPubkey: payer, lamports: 1 }),
  );
  const fee = (await rpc.getFeeForMessage(tx.compileMessage(), 'finalized')).value;
  if (!fee || fee > 100_000) throw new Error('Unexpected network fee; payouts paused');
  return BigInt(fee);
}
async function recordAndBroadcast(
  rpc: Connection,
  launch: TokenLaunch,
  kind: 'CLAIM' | 'PAYOUT' | 'PLATFORM',
  roundId: string | null,
  instructions: TransactionInstruction[],
  expectedCost: bigint | null,
  key: string,
  onRecorded?: (tx: Prisma.TransactionClient, signature: string) => Promise<void>,
) {
  const gas = operator(),
    fee = feeKey(launch);
  const block = await rpc.getLatestBlockhash('finalized');
  const tx = new Transaction({ feePayer: gas.publicKey, recentBlockhash: block.blockhash }).add(
    ...instructions,
  );
  const message = tx.compileMessage();
  const actualEstimate = (await rpc.getFeeForMessage(message, 'finalized')).value;
  if (
    !actualEstimate ||
    actualEstimate > 100_000 ||
    (expectedCost !== null && BigInt(actualEstimate) !== expectedCost)
  )
    throw new Error('Network fee changed before signing');
  const signers = message.accountKeys.slice(0, message.header.numRequiredSignatures);
  tx.sign(...(signers.some((k) => k.equals(fee.publicKey)) ? [gas, fee] : [gas]));
  const raw = tx.serialize();
  const simulation = await rpc.simulateTransaction(VersionedTransaction.deserialize(raw), {
    sigVerify: true,
    commitment: 'finalized',
  });
  if (simulation.value.err) throw new Error(`${kind} simulation failed; inspect chain accounts.`);
  const signature = bs58.encode(tx.signature!);
  const row = await db.$transaction(async (t) => {
    const record = await t.financialTx.create({
      data: {
        key,
        launchId: launch.id,
        roundId,
        raidId: roundId
          ? (await t.rewardRound.findUniqueOrThrow({ where: { id: roundId } })).raidId
          : null,
        kind,
        raw: raw.toString('base64'),
        signature,
        blockhash: block.blockhash,
        lastValidBlockHeight: block.lastValidBlockHeight,
        costLamports: BigInt(actualEstimate),
      },
    });
    if (onRecorded) await onRecorded(t, signature);
    return record;
  });
  await rpc.sendRawTransaction(raw, { maxRetries: 3 }).catch(() => {});
  return row;
}
async function verifyFeeRecipient(rpc: Connection, launch: TokenLaunch) {
  const mint = new PublicKey(launch.mint),
    expected = new PublicKey(launch.feeAddress);
  const info = await rpc.getAccountInfo(bondingCurvePda(mint), 'finalized');
  const wallet = await rpc.getAccountInfo(expected, 'finalized');
  if (
    !info?.owner.equals(PUMP_PROGRAM_ID) ||
    (wallet && (!wallet.owner.equals(SystemProgram.programId) || wallet.executable)) ||
    wallet?.owner.equals(PUMP_FEE_PROGRAM_ID)
  )
    throw new Error('Fee recipient or bonding curve changed');
  const curve = PUMP_SDK.decodeBondingCurve(info);
  if (
    !curve.creator.equals(expected) ||
    curve.isHolderReward ||
    curve.isMayhemMode ||
    !curve.quoteMint.equals(PublicKey.default)
  )
    throw new Error('Bonding curve fee recipient changed');
  if (curve.complete) {
    const pool = await getPumpAmmProgram(rpc).account.pool.fetchNullable(
      canonicalPumpPoolPda(mint),
    );
    if (!pool || !pool.coinCreator.equals(expected))
      throw new Error('Graduated pool fee recipient changed');
  }
  return curve;
}
async function reconcileFinancial(rpc: Connection, launch: TokenLaunch) {
  const open = await db.financialTx.findFirst({
    where: { launchId: launch.id, status: 'SIGNED' },
    orderBy: { createdAt: 'asc' },
  });
  if (!open) return false;
  const result = (
    await rpc.getSignatureStatuses([open.signature], { searchTransactionHistory: true })
  ).value[0];
  if (result?.confirmationStatus === 'finalized' && !result.err) {
    const tx = await rpc.getTransaction(open.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta || tx.meta.err) throw new Error('Finalized financial transaction unavailable');
    const actualCost = BigInt(tx.meta.fee);
    if (actualCost !== open.costLamports) {
      await db.tokenLaunch.update({
        where: { id: launch.id },
        data: { status: 'PAUSED', error: 'Network fee differed from approved accounting.' },
      });
      throw new Error('Network fee mismatch');
    }
    await db.$transaction(async (t) => {
      if (open.kind === 'CLAIM') {
        const keys = tx.transaction.message.staticAccountKeys;
        const index = keys.findIndex((k) => k.toBase58() === launch.feeAddress);
        if (index < 0) throw new Error('Claim recipient missing from transaction');
        const gross = BigInt(tx.meta!.postBalances[index]) - BigInt(tx.meta!.preBalances[index]);
        if (gross < 0n) throw new Error('Negative claim');
        await t.feeClaim.upsert({
          where: { signature: open.signature },
          create: {
            launchId: launch.id,
            raidId: open.raidId,
            signature: open.signature,
            source: 'bonding-curve-and-amm',
            grossLamports: gross,
            costLamports: actualCost,
          },
          update: {},
        });
        if (open.raidId)
          await t.raid.updateMany({
            where: {
              id: open.raidId,
              trackingVersion: 2,
              endsAt: { lte: open.createdAt },
              finalFeeSweepAt: null,
            },
            data: { finalFeeSweepAt: new Date() },
          });
      } else if (open.kind === 'PAYOUT') {
        await t.rewardPayout.updateMany({
          where: { signature: open.signature },
          data: { status: 'PAID', paidAt: new Date() },
        });
      } else if (open.roundId) {
        await t.rewardRound.update({
          where: { id: open.roundId },
          data: { status: 'SETTLED', settledAt: new Date() },
        });
      }
      await t.financialTx.update({
        where: { id: open.id },
        data: { status: 'CONFIRMED', costLamports: actualCost, confirmedAt: new Date() },
      });
    });
    return false;
  }
  if (result?.err) {
    const failed = await rpc.getTransaction(open.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!failed?.meta?.err) throw new Error('Failed transaction receipt unavailable');
    await db.$transaction(async (t) => {
      await t.feeClaim.upsert({
        where: { signature: open.signature },
        create: {
          launchId: launch.id,
          signature: open.signature,
          raidId: open.raidId,
          source: 'failed-network-cost',
          grossLamports: 0n,
          costLamports: BigInt(failed.meta!.fee),
        },
        update: {},
      });
      await t.financialTx.update({
        where: { id: open.id },
        data: { status: 'FAILED', costLamports: BigInt(failed.meta!.fee), confirmedAt: new Date() },
      });
      if (open.kind === 'PAYOUT')
        await t.rewardPayout.updateMany({
          where: { signature: open.signature },
          data: { signature: null, status: 'READY' },
        });
      await t.tokenLaunch.update({
        where: { id: launch.id },
        data: {
          status: 'PAUSED',
          error: `On-chain ${open.kind.toLowerCase()} failed; inspect ${open.signature}.`,
        },
      });
    });
    return true;
  }
  if ((await rpc.getBlockHeight('finalized')) > open.lastValidBlockHeight) {
    if (Date.now() - +open.createdAt < 5 * 60000) return true;
    await db.tokenLaunch.update({
      where: { id: launch.id },
      data: {
        status: 'PAUSED',
        error: `Signed ${open.kind.toLowerCase()} expired without a definitive receipt; inspect ${open.signature} before resuming.`,
      },
    });
    return true;
  }
  await rpc.sendRawTransaction(Buffer.from(open.raw, 'base64'), { maxRetries: 2 }).catch(() => {});
  return true;
}
async function claimFees(rpc: Connection, launch: TokenLaunch, raidId?: string) {
  const fee = new PublicKey(launch.feeAddress),
    gas = operator();
  const curveVault = creatorVaultPda(fee);
  const nativeVault = getAssociatedTokenAddressSync(NATIVE_MINT, ammCreatorVaultPda(fee), true);
  const [curveInfo, ammInfo] = await rpc.getMultipleAccountsInfo(
    [curveVault, nativeVault],
    'finalized',
  );
  const rent = curveInfo ? await rpc.getMinimumBalanceForRentExemption(curveInfo.data.length) : 0;
  const curveAmount = BigInt(Math.max(0, (curveInfo?.lamports || 0) - rent));
  const ammAmount = ammInfo
    ? BigInt((await rpc.getTokenAccountBalance(nativeVault, 'finalized')).value.amount)
    : 0n;
  if (curveAmount + ammAmount < 1_000_000n) return false;
  const sdk = new OnlinePumpSdk(rpc);
  const instructions = await sdk.collectCoinCreatorFeeV2Instructions(
    fee,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    gas.publicKey,
  );
  if (ammAmount === 0n) instructions.splice(1);
  if (ammAmount > 0n) {
    const destination = getAssociatedTokenAddressSync(NATIVE_MINT, fee, true);
    if (await rpc.getAccountInfo(destination, 'finalized'))
      throw new Error('Unexpected fee wallet WSOL account');
    const accountRent = BigInt(await rpc.getMinimumBalanceForRentExemption(165));
    instructions.splice(
      1,
      0,
      createAssociatedTokenAccountIdempotentInstruction(
        gas.publicKey,
        destination,
        fee,
        NATIVE_MINT,
      ),
    );
    instructions.push(createCloseAccountInstruction(destination, fee, fee));
    instructions.push(
      SystemProgram.transfer({ fromPubkey: fee, toPubkey: gas.publicKey, lamports: accountRent }),
    );
  }
  await recordAndBroadcast(
    rpc,
    launch,
    'CLAIM',
    null,
    instructions,
    null,
    `claim:${launch.id}:${randomUUID()}`,
    raidId
      ? async (tx, signature) => {
          await tx.financialTx.update({ where: { signature }, data: { raidId } });
        }
      : undefined,
  );
  return true;
}
export async function settleNextRound(rpc: Connection, launch: TokenLaunch) {
  const raids = await db.raid.findMany({
    where: { tokenLaunchId: launch.id, status: { in: ['ACTIVE', 'ENDED'] } },
    orderBy: { startsAt: 'asc' },
  });
  for (const raid of raids) {
    if (raid.hidden) continue;
    const reviewed = raid.trackingVersion === 2;
    if (
      reviewed &&
      (!trackingSettlementEnabled() ||
        raid.trackingPhase !== 'APPROVED' ||
        !raid.activeResultId ||
        !raid.finalFeeSweepAt)
    )
      continue;
    const result = reviewed
      ? await db.campaignResult.findUnique({ where: { id: raid.activeResultId! } })
      : null;
    const resultData = result?.payload as unknown as ResultPayload | undefined;
    if (reviewed && (!resultData || result?.raidId !== raid.id)) continue;
    const previous = await db.rewardRound.findMany({
      where: { raidId: raid.id },
      select: { startsAt: true },
    });
    const done = new Set(previous.map((r) => +r.startsAt));
    let starts = +raid.startsAt;
    while (starts < Math.min(+raid.endsAt, Date.now())) {
      const ends = reviewed ? +raid.endsAt : Math.min(starts + 3600000, +raid.endsAt);
      if (!done.has(starts) && ends <= Date.now() - 60000) {
        if (
          raid.coverage !== 'complete' ||
          !raid.coveredUntil ||
          +raid.coveredUntil < ends ||
          raid.nextToken ||
          raid.searchEndAt
        )
          return false;
        const claims = await db.feeClaim.findMany({
          where: { launchId: launch.id, roundId: null, raidId: reviewed ? raid.id : null },
          orderBy: { claimedAt: 'asc' },
        });
        if (!claims.length) {
          if (reviewed)
            await db.raid.updateMany({
              where: { id: raid.id, trackingPhase: 'APPROVED' },
              data: { trackingPhase: 'HELD', holdReason: 'NO_COLLECTED_FEES' },
            });
          return false;
        }
        const gross = claims.reduce((a, c) => a + c.grossLamports, 0n),
          claimCost = claims.reduce((a, c) => a + c.costLamports, 0n);
        const members = reviewed
          ? resultData!.participants
          : await db.rewardEnrollment.findMany({
              where: { launchId: launch.id, joinedAt: { lt: new Date(ends) } },
            });
        const posts = await db.post.findMany({
          where: { raidId: raid.id, createdAt: { lt: new Date(ends) } },
        });
        const scores = reviewed
          ? new Map(
              resultData!.participants.filter((m) => m.score > 0).map((m) => [m.xId, m.score]),
            )
          : authorScores(
              posts,
              new Date(starts),
              new Date(ends),
              new Map(members.map((m) => [m.xId, new Date(m.joinedAt)])),
            );
        if (!scores.size) {
          starts = ends;
          continue;
        }
        const block = await rpc.getLatestBlockhash('finalized');
        const fee = await expectedFee(
          rpc,
          operator().publicKey,
          new PublicKey(launch.feeAddress),
          block.blockhash,
        );
        const prior = await db.rewardPayout.findMany({
          where: { launchId: launch.id, status: 'PENDING' },
        });
        let split = splitRewards(gross, claimCost, 0n, scores);
        if (!split) {
          if (reviewed)
            await db.raid.updateMany({
              where: { id: raid.id, trackingPhase: 'APPROVED' },
              data: { trackingPhase: 'HELD', holdReason: 'INSUFFICIENT_FUNDS' },
            });
          return false;
        }
        const payableWith = (amounts: Map<string, bigint>) => {
          const sums = new Map<string, bigint>();
          for (const p of prior)
            sums.set(p.walletAddress, (sums.get(p.walletAddress) || 0n) + p.lamports);
          for (const member of members)
            sums.set(
              member.walletAddress,
              (sums.get(member.walletAddress) || 0n) + (amounts.get(member.xId) || 0n),
            );
          return [...sums]
            .filter(([, amount]) => amount >= MIN_PAYOUT)
            .map(([wallet]) => wallet)
            .sort();
        };
        let payables = payableWith(split.amounts);
        const maxIterations = payables.length + 1;
        for (let i = 0; i < maxIterations; i++) {
          const candidate = splitRewards(
            gross,
            claimCost,
            fee * BigInt(payables.length + 1),
            scores,
          );
          if (!candidate) {
            if (reviewed)
              await db.raid.updateMany({
                where: { id: raid.id, trackingPhase: 'APPROVED' },
                data: { trackingPhase: 'HELD', holdReason: 'INSUFFICIENT_FUNDS' },
              });
            return false;
          }
          split = candidate;
          const valid = new Set(payableWith(split.amounts));
          const reduced = payables.filter((wallet) => valid.has(wallet));
          if (reduced.length === payables.length) break;
          payables = reduced;
        }
        const plannedCost = claimCost + fee * BigInt(payables.length + 1);
        if (gross <= plannedCost) return false;
        await db.$transaction(async (t) => {
          await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reward:${launch.id}`}, 0))`;
          if (reviewed) {
            await lockTracking(t, raid.id);
            const current = await t.raid.findUniqueOrThrow({
              where: { id: raid.id },
              include: { creator: true },
            });
            if (
              !trackingSettlementEnabled() ||
              current.hidden ||
              current.creator.suspended ||
              current.trackingPhase !== 'APPROVED' ||
              current.activeResultId !== result!.id ||
              !current.reviewEndsAt ||
              current.reviewEndsAt > new Date() ||
              (await trackingBlockers(t, raid.id))
            )
              throw new Error('Reviewed result is not eligible for settlement.');
          }
          const claimed = await t.feeClaim.updateMany({
            where: { id: { in: claims.map((c) => c.id) }, roundId: null },
            data: { roundId: `pending:${raid.id}:${starts}` },
          });
          if (claimed.count !== claims.length)
            throw new Error('Claims were allocated concurrently');
          const round = await t.rewardRound.create({
            data: {
              launchId: launch.id,
              raidId: raid.id,
              startsAt: new Date(starts),
              endsAt: new Date(ends),
              status: 'READY',
              ...(reviewed ? { resultSnapshotId: result!.id, settlementRaidId: raid.id } : {}),
              grossLamports: gross,
              costLamports: plannedCost,
              platformLamports: split.platform,
              raiderLamports: split.raiders,
            },
          });
          if (reviewed)
            await t.raid.update({ where: { id: raid.id }, data: { trackingPhase: 'ALLOCATED' } });
          await t.feeClaim.updateMany({
            where: { roundId: `pending:${raid.id}:${starts}` },
            data: { roundId: round.id },
          });
          for (const member of members) {
            const amount = split.amounts.get(member.xId);
            if (amount && amount > 0n)
              await t.rewardPayout.create({
                data: {
                  launchId: launch.id,
                  roundId: round.id,
                  xId: member.xId,
                  walletAddress: member.walletAddress,
                  score: scores.get(member.xId)!,
                  lamports: amount,
                  ...(payables.includes(member.walletAddress)
                    ? { status: 'READY', payoutBatchRoundId: round.id }
                    : {}),
                },
              });
          }
          await t.rewardPayout.updateMany({
            where: {
              id: { in: prior.filter((p) => payables.includes(p.walletAddress)).map((p) => p.id) },
            },
            data: { status: 'READY', payoutBatchRoundId: round.id },
          });
        });
        return true;
      }
      starts = ends;
    }
  }
  return false;
}
async function payRound(rpc: Connection, launch: TokenLaunch) {
  const round = await db.rewardRound.findFirst({
    where: { launchId: launch.id, status: 'READY' },
    orderBy: { startsAt: 'asc' },
  });
  if (!round) return false;
  if (round.resultSnapshotId && !trackingSettlementEnabled()) return false;
  const gas = operator(),
    fee = feeKey(launch);
  const ready = await db.rewardPayout.findMany({
    where: { payoutBatchRoundId: round.id, status: 'READY' },
    orderBy: { walletAddress: 'asc' },
  });
  const wallet = ready[0]?.walletAddress;
  if (wallet) {
    const rows = ready.filter((p) => p.walletAddress === wallet);
    const amount = rows.reduce((a, p) => a + p.lamports, 0n);
    const block = await rpc.getLatestBlockhash('finalized');
    const cost = await expectedFee(rpc, gas.publicKey, fee.publicKey, block.blockhash);
    if (BigInt(await rpc.getBalance(fee.publicKey, 'finalized')) < amount + cost)
      throw new Error('Fee wallet balance insufficient for recorded payouts');
    await recordAndBroadcast(
      rpc,
      launch,
      'PAYOUT',
      round.id,
      [
        SystemProgram.transfer({
          fromPubkey: fee.publicKey,
          toPubkey: new PublicKey(wallet),
          lamports: amount,
        }),
        SystemProgram.transfer({
          fromPubkey: fee.publicKey,
          toPubkey: gas.publicKey,
          lamports: cost,
        }),
      ],
      cost,
      `pay:${round.id}:${wallet}:${randomUUID()}`,
      async (t, signature) => {
        const updated = await t.rewardPayout.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, status: 'READY' },
          data: { signature, status: 'SENT' },
        });
        if (updated.count !== rows.length) throw new Error('Payout rows changed before signing');
      },
    );
    return true;
  }
  const claimCosts = (await db.feeClaim.findMany({ where: { roundId: round.id } })).reduce(
    (a, c) => a + c.costLamports,
    0n,
  );
  const block = await rpc.getLatestBlockhash('finalized');
  const cost = await expectedFee(rpc, gas.publicKey, fee.publicKey, block.blockhash);
  if (
    BigInt(await rpc.getBalance(fee.publicKey, 'finalized')) <
    round.platformLamports + claimCosts + cost
  )
    throw new Error('Fee wallet balance insufficient for recorded fees');
  await recordAndBroadcast(
    rpc,
    launch,
    'PLATFORM',
    round.id,
    [
      SystemProgram.transfer({
        fromPubkey: fee.publicKey,
        toPubkey: new PublicKey(process.env.PLATFORM_TREASURY_ADDRESS!),
        lamports: round.platformLamports,
      }),
      SystemProgram.transfer({
        fromPubkey: fee.publicKey,
        toPubkey: gas.publicKey,
        lamports: claimCosts + cost,
      }),
    ],
    cost,
    `platform:${round.id}:${randomUUID()}`,
  );
  return true;
}
export async function financeLaunch(launchId: string) {
  if (config.demo || !process.env.OPERATOR_SECRET_KEY || !process.env.SOLANA_RPC_URL) return;
  const settings = await db.settings.findUnique({ where: { id: 'global' } });
  const launch = await db.tokenLaunch.findUnique({ where: { id: launchId } });
  if (!launch || !['LIVE', 'PAUSED'].includes(launch.status)) return;
  const rpc = connection();
  try {
    await assertMainnet(rpc);
    await verifyFeeRecipient(rpc, launch);
    if (await reconcileFinancial(rpc, launch)) return;
    if (await db.financialTx.count({ where: { launchId, status: 'SIGNED' } })) return;
    if (
      !payoutsEnabled() ||
      !settings?.collectionEnabled ||
      settings.payoutPaused ||
      launch.status !== 'LIVE'
    )
      return;
    if (await payRound(rpc, launch)) return;
    const currentRaid = launch.raidId
      ? await db.raid.findUnique({ where: { id: launch.raidId } })
      : null;
    if (currentRaid?.trackingVersion === 2) {
      if (!trackingEnabled()) return;
      if (!currentRaid.finalFeeSweepAt && currentRaid.trackingPhase !== 'ALLOCATED') {
        if (await claimFees(rpc, launch, currentRaid.id)) return;
        if (currentRaid.endsAt <= new Date())
          await db.raid.update({
            where: { id: currentRaid.id },
            data: { finalFeeSweepAt: new Date() },
          });
      }
      await settleNextRound(rpc, launch);
    } else {
      if (await settleNextRound(rpc, launch)) return;
      await claimFees(rpc, launch);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 200) : 'Finance failed';
    if (
      /recipient changed|fee mismatch|Graduated pool|balance insufficient|Unexpected fee wallet WSOL/.test(
        reason,
      )
    )
      await db.tokenLaunch.update({
        where: { id: launchId },
        data: { status: 'PAUSED', error: reason },
      });
    throw error;
  }
}
