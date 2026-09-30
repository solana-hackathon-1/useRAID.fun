import { newTrackingRules } from './config';
import { launchpadsAvailable } from './release';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { PUMP_SDK, PUMP_PROGRAM_ID, bondingCurvePda } from './pump-sdk';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { db } from './db';
import { config } from './config';
import { HttpError } from './auth-primitives';
import { encryptSecret, decryptSecret } from './launch-crypto';
import { pinMetadata, ipfsUri, verifyAsset } from './launch-ipfs';
import { walletAddress } from './wallet-auth';
import { verifySignedLaunch } from './launch-signatures';

const optionalUrl = z
  .union([
    z.literal(''),
    z
      .string()
      .url()
      .refine((v) => new URL(v).protocol === 'https:'),
  ])
  .optional();
export const launchInput = z.object({
  name: z.string().trim().min(1).max(32),
  symbol: z.string().trim().min(1).max(10),
  description: z.string().trim().min(1).max(1000),
  imageUri: z.string(),
  imageProof: z.string(),
  bannerUri: z.string().optional(),
  bannerProof: z.string().optional(),
  website: optionalUrl,
  x: optionalUrl,
  telegram: optionalUrl,
  discord: optionalUrl,
});
export function launchEnabled() {
  return (
    launchpadsAvailable &&
    !config.demo &&
    Reflect.get(process.env, 'LAUNCH_ENABLED') === 'true' &&
    config.liveApproved &&
    Reflect.get(process.env, 'PAYOUT_ENABLED') === 'true' &&
    !!process.env.OPERATOR_PUBLIC_KEY &&
    !!process.env.PLATFORM_TREASURY_ADDRESS &&
    !!process.env.X_BEARER_TOKEN &&
    !!process.env.SOLANA_RPC_URL &&
    !!process.env.PINATA_JWT &&
    !!process.env[`LAUNCH_KEY_${process.env.LAUNCH_KEY_VERSION || '1'}`]
  );
}
export async function assertMainnet(rpc: Connection) {
  if ((await rpc.getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
    throw new HttpError(503, 'Solana RPC must point to mainnet.');
}
export function connection() {
  const url = process.env.SOLANA_RPC_URL;
  if (!url || !/^https:\/\//.test(url)) throw new HttpError(503, 'Solana RPC unavailable.');
  return new Connection(url, 'finalized');
}
export async function prepareLaunch(userId: string, input: unknown) {
  if (!launchEnabled()) throw new HttpError(503, 'Token launches unavailable.');
  const data = launchInput.parse(input);
  verifyAsset(data.imageUri, 'logo', userId, data.imageProof);
  if (data.bannerUri) {
    if (!data.bannerProof) throw new HttpError(400, 'Banner upload verification required.');
    verifyAsset(data.bannerUri, 'banner', userId, data.bannerProof);
  }
  const wallet = await db.walletIdentity.findUnique({ where: { userId } });
  if (!wallet) throw new HttpError(403, 'Connect and verify your Solana wallet.');
  const rpc = connection();
  await assertMainnet(rpc);
  if (
    walletAddress(process.env.OPERATOR_PUBLIC_KEY!).equals(
      walletAddress(process.env.PLATFORM_TREASURY_ADDRESS!),
    )
  )
    throw new HttpError(503, 'Operator and treasury wallets must differ.');
  const settings = await db.settings.findUnique({ where: { id: 'global' } });
  if (
    !settings?.collectionEnabled ||
    settings.launchPaused ||
    settings.payoutPaused ||
    !settings.payoutWorkerAt ||
    +settings.payoutWorkerAt < Date.now() - 120000 ||
    settings.operatorAddress !== process.env.OPERATOR_PUBLIC_KEY
  )
    throw new HttpError(503, 'Raid collection and payout worker must be active before launch.');
  const mint = Keypair.generate(),
    feeWallet = Keypair.generate();
  const image = ipfsUri(data.imageUri);
  const banner = data.bannerUri ? ipfsUri(data.bannerUri) : undefined;
  const uri = await pinMetadata({
    name: data.name,
    symbol: data.symbol,
    description: data.description,
    image,
    ...(banner ? { banner } : {}),
    website: data.website || `${config.appUrl}/tokens/${mint.publicKey}`,
    ...(data.x ? { twitter: data.x } : {}),
    ...(data.telegram ? { telegram: data.telegram } : {}),
    ...(data.discord ? { discord: data.discord } : {}),
  });
  if (uri.length > 200) throw new HttpError(503, 'Metadata URI too long.');
  const launch = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(729103)`;
    const current = await tx.settings.findUnique({ where: { id: 'global' } });
    if (
      !current?.collectionEnabled ||
      current.launchPaused ||
      current.payoutPaused ||
      !current.payoutWorkerAt ||
      +current.payoutWorkerAt < Date.now() - 120000 ||
      current.operatorAddress !== process.env.OPERATOR_PUBLIC_KEY
    )
      throw new HttpError(503, 'Launch paused or payout worker unavailable.');
    const reserved =
      (await tx.raid.count({
        where: { status: { in: ['ACTIVE', 'SCHEDULED'] }, endsAt: { gt: new Date() } },
      })) +
      (await tx.tokenLaunch.count({
        where: {
          OR: [
            { status: 'SUBMITTED' },
            { status: 'PREPARED', reservationExpiresAt: { gt: new Date() } },
          ],
        },
      }));
    if (reserved >= current.maxActiveRaids) throw new HttpError(409, 'Campaign capacity full.');
    return tx.tokenLaunch.create({
      data: {
        userId,
        mint: mint.publicKey.toBase58(),
        name: data.name,
        symbol: data.symbol,
        description: data.description,
        metadataUri: uri,
        imageUri: image,
        bannerUri: banner,
        feeAddress: feeWallet.publicKey.toBase58(),
        reservationExpiresAt: new Date(Date.now() + 3600000),
        feeSecret: encryptSecret(feeWallet.secretKey, `fee:${mint.publicKey}`),
        mintSecret: encryptSecret(mint.secretKey, `mint:${mint.publicKey}`),
      },
    });
  });
  return buildLaunchTransaction(launch.id, userId);
}
export async function buildLaunchTransaction(id: string, userId: string) {
  if (!launchpadsAvailable) throw new HttpError(503, 'Launchpads are coming soon.');
  const launch = await db.tokenLaunch.findUnique({ where: { id } });
  if (!launch || launch.userId !== userId) throw new HttpError(404, 'Launch not found.');
  if (launch.status === 'LIVE') return publicLaunch(launch);
  if (launch.status === 'SUBMITTED') return publicLaunch(launch);
  if (!launch.reservationExpiresAt || launch.reservationExpiresAt <= new Date()) {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(729103)`;
      const current = await tx.tokenLaunch.findUniqueOrThrow({ where: { id } });
      if (current.reservationExpiresAt && current.reservationExpiresAt > new Date()) return;
      const settings = await tx.settings.findUnique({ where: { id: 'global' } });
      if (!settings?.collectionEnabled || settings.launchPaused || settings.payoutPaused)
        throw new HttpError(503, 'Launch paused.');
      const reserved =
        (await tx.raid.count({
          where: { status: { in: ['ACTIVE', 'SCHEDULED'] }, endsAt: { gt: new Date() } },
        })) +
        (await tx.tokenLaunch.count({
          where: {
            id: { not: id },
            OR: [
              { status: 'SUBMITTED' },
              { status: 'PREPARED', reservationExpiresAt: { gt: new Date() } },
            ],
          },
        }));
      if (reserved >= settings.maxActiveRaids) throw new HttpError(409, 'Campaign capacity full.');
      await tx.tokenLaunch.update({
        where: { id },
        data: { reservationExpiresAt: new Date(Date.now() + 3600000) },
      });
    });
  }
  const mint = Keypair.fromSecretKey(decryptSecret(launch.mintSecret, `mint:${launch.mint}`));
  const user = await db.walletIdentity.findUnique({ where: { userId } });
  if (!user) throw new HttpError(403, 'Wallet disconnected.');
  const payer = walletAddress(user.address);
  const rpc = connection();
  await assertMainnet(rpc);
  if (await rpc.getAccountInfo(mint.publicKey)) {
    await reconcileLaunch(id);
    return publicLaunch(await db.tokenLaunch.findUniqueOrThrow({ where: { id } }));
  }
  const block = await rpc.getLatestBlockhash('finalized');
  const ix = await PUMP_SDK.createV2Instruction({
    mint: mint.publicKey,
    name: launch.name,
    symbol: launch.symbol,
    uri: launch.metadataUri,
    creator: walletAddress(launch.feeAddress),
    user: payer,
    mayhemMode: false,
    holderReward: false,
  });
  const tx = new Transaction({ feePayer: payer, recentBlockhash: block.blockhash }).add(ix);
  tx.partialSign(mint);
  const message = tx.serializeMessage();
  const prepared = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
  await db.tokenLaunch.update({
    where: { id },
    data: {
      preparedTx: prepared,
      preparedHash: createHash('sha256').update(message).digest('hex'),
      blockhash: block.blockhash,
      lastValidBlockHeight: block.lastValidBlockHeight,
      status: 'PREPARED',
      error: null,
    },
  });
  const rent = await rpc.getMinimumBalanceForRentExemption(82).catch(() => 0);
  return {
    id,
    mint: launch.mint,
    feeAddress: launch.feeAddress,
    transaction: prepared,
    estimatedLamports: rent + 50000,
    metadataUri: launch.metadataUri,
  };
}
export function publicLaunch(launch: {
  id: string;
  mint: string;
  name: string;
  symbol: string;
  feeAddress: string;
  status: string;
  signature: string | null;
  raidId: string | null;
  error: string | null;
}) {
  return {
    id: launch.id,
    mint: launch.mint,
    feeAddress: launch.feeAddress,
    status: launch.status,
    name: launch.name,
    symbol: launch.symbol,
    signature: launch.signature,
    raidId: launch.raidId,
    error: launch.error,
  };
}
export async function submitLaunch(id: string, userId: string, rawBase64: string) {
  if (!launchEnabled()) throw new HttpError(503, 'Token launches unavailable.');
  const settings = await db.settings.findUnique({ where: { id: 'global' } });
  if (
    !settings?.collectionEnabled ||
    settings.launchPaused ||
    settings.payoutPaused ||
    !settings.payoutWorkerAt ||
    +settings.payoutWorkerAt < Date.now() - 120000 ||
    settings.operatorAddress !== process.env.OPERATOR_PUBLIC_KEY
  )
    throw new HttpError(503, 'Payout worker unavailable. Wait before signing launch.');
  const launch = await db.tokenLaunch.findUnique({ where: { id } });
  if (!launch || launch.userId !== userId) throw new HttpError(404, 'Launch not found.');
  if (
    launch.status !== 'PREPARED' ||
    !launch.preparedHash ||
    !launch.reservationExpiresAt ||
    launch.reservationExpiresAt <= new Date()
  )
    throw new HttpError(409, 'Launch reservation expired. Prepare and sign again.');
  const wallet = await db.walletIdentity.findUnique({ where: { userId } });
  if (!wallet) throw new HttpError(403, 'Wrong wallet signed launch.');
  const { tx, raw, signature } = verifySignedLaunch(rawBase64, {
    preparedHash: launch.preparedHash,
    mint: launch.mint,
    payer: wallet.address,
    programId: PUMP_PROGRAM_ID,
  });
  const rpc = connection();
  await assertMainnet(rpc);
  if (
    launch.lastValidBlockHeight &&
    (await rpc.getBlockHeight('finalized')) > launch.lastValidBlockHeight
  )
    throw new HttpError(409, 'Transaction expired. Prepare and sign again.');
  const simulation = await rpc.simulateTransaction(tx);
  if (simulation.value.err)
    throw new HttpError(400, 'Launch simulation failed. Check wallet balance and retry.');
  await db.tokenLaunch.update({
    where: { id },
    data: { signature, signedTx: raw.toString('base64'), status: 'SUBMITTED' },
  });
  try {
    await rpc.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  } catch (error) {
    await db.tokenLaunch.update({
      where: { id },
      data: { error: error instanceof Error ? error.message.slice(0, 200) : 'Broadcast failed' },
    });
    throw new HttpError(503, 'Launch submission pending. Check status before retrying.');
  }
  return publicLaunch(await db.tokenLaunch.findUniqueOrThrow({ where: { id } }));
}
export async function reconcileLaunch(id: string) {
  const launch = await db.tokenLaunch.findUniqueOrThrow({ where: { id } });
  if (launch.status === 'LIVE' || !launch.signature) return publicLaunch(launch);
  const rpc = connection();
  await assertMainnet(rpc);
  const status = await rpc.getSignatureStatuses([launch.signature], {
    searchTransactionHistory: true,
  });
  if (status.value[0]?.err) {
    await db.tokenLaunch.update({
      where: { id },
      data: { status: 'FAILED', error: 'Launch transaction failed on chain.' },
    });
    return publicLaunch(await db.tokenLaunch.findUniqueOrThrow({ where: { id } }));
  }
  if (status.value[0]?.confirmationStatus !== 'finalized') {
    if (
      !status.value[0] &&
      launch.signedTx &&
      launch.lastValidBlockHeight &&
      (await rpc.getBlockHeight('finalized')) <= launch.lastValidBlockHeight
    )
      await rpc
        .sendRawTransaction(Buffer.from(launch.signedTx, 'base64'), { maxRetries: 2 })
        .catch(() => {});
    if (
      !status.value[0] &&
      launch.lastValidBlockHeight &&
      (await rpc.getBlockHeight('finalized')) > launch.lastValidBlockHeight
    ) {
      if (await rpc.getAccountInfo(new PublicKey(launch.mint), 'finalized'))
        throw new Error('Mint exists but launch receipt is unavailable; inspect before retrying.');
      await db.tokenLaunch.update({
        where: { id },
        data: {
          status: 'PREPARED',
          signature: null,
          signedTx: null,
          error: 'Blockhash expired. Sign a fresh transaction.',
        },
      });
    }
    return publicLaunch(await db.tokenLaunch.findUniqueOrThrow({ where: { id } }));
  }
  const tx = await rpc.getTransaction(launch.signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'finalized',
  });
  const payer = (await db.walletIdentity.findUniqueOrThrow({ where: { userId: launch.userId } }))
    .address;
  if (
    !tx ||
    tx.meta?.err ||
    tx.transaction.message.staticAccountKeys[0].toBase58() !== payer ||
    createHash('sha256').update(tx.transaction.message.serialize()).digest('hex') !==
      launch.preparedHash
  )
    throw new Error('Finalized launch transaction mismatch.');
  const mintInfo = await rpc.getAccountInfo(new PublicKey(launch.mint), 'finalized');
  const curveInfo = await rpc.getAccountInfo(
    bondingCurvePda(new PublicKey(launch.mint)),
    'finalized',
  );
  if (!mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) || !curveInfo?.owner.equals(PUMP_PROGRAM_ID))
    throw new Error('Finalized mint or curve unavailable.');
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  if (
    !curve.creator.equals(new PublicKey(launch.feeAddress)) ||
    curve.isHolderReward ||
    curve.isMayhemMode ||
    !curve.quoteMint.equals(PublicKey.default)
  )
    throw new Error('On-chain creator fee or pair differs from review.');
  return db.$transaction(async (txDb) => {
    await txDb.$executeRaw`SELECT pg_advisory_xact_lock(729103)`;
    const current = await txDb.tokenLaunch.findUniqueOrThrow({ where: { id } });
    if (current.status === 'LIVE') return publicLaunch(current);
    const now = new Date();
    const token = await txDb.token.upsert({
      where: { mint: launch.mint },
      create: { mint: launch.mint, name: launch.name, symbol: launch.symbol },
      update: {},
    });
    const raid = await txDb.raid.create({
      data: {
        ...newTrackingRules(),
        tag: `raid_${launch.mint.slice(0, 10).toLowerCase()}`,
        title: `${launch.name} launch raid`,
        description:
          launch.description.length >= 20
            ? launch.description
            : `${launch.name} community launch campaign`,
        mint: token.mint,
        creatorId: launch.userId,
        tokenLaunchId: launch.id,
        status: 'ACTIVE',
        startsAt: now,
        endsAt: new Date(+now + 24 * 3600000),
      },
    });
    const updated = await txDb.tokenLaunch.update({
      where: { id },
      data: { raidId: raid.id, status: 'LIVE', error: null },
    });
    return publicLaunch(updated);
  });
}
