import { randomBytes } from 'node:crypto';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { DynamicFeeSharingClient, deriveFeeVaultPdaAddress } from '@meteora-ag/dynamic-fee-sharing-sdk';
import { z } from 'zod';
import type { TokenLaunch } from '@prisma/client';
import { db } from '../db';
import { HttpError } from '../auth-primitives';
import { decryptSecret, encryptSecret } from '../launch-crypto';
import { pinMetadata, verifyAsset } from '../launch-ipfs';
import { assertMeteoraEnabled, assertMeteoraNetwork, meteoraConnection, meteoraNetwork } from './config';
import { buildLaunchCurve } from './template';
import { prepareStep, rebroadcastStep, submitStep } from './transactions';
import { verifyLaunchChain } from './state';
const url = z.union([z.literal(''), z.url().refine(v => new URL(v).protocol === 'https:')]).optional();
export const meteoraLaunchInput = z.object({
  provider: z.literal('METEORA').default('METEORA'), name: z.string().trim().min(1).max(32).refine(v=>Buffer.byteLength(v,'utf8')<=32,'Name must fit 32 UTF-8 bytes.'),
  symbol: z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/, 'Ticker must contain 1–10 letters or numbers.'),
  description: z.string().trim().max(1000).default(''), imageUri: z.string(), imageProof: z.string(),
  website: url, x: url, telegram: url,
});
export async function ownedLaunch(id: string, userId: string) {
  const launch = await db.tokenLaunch.findUnique({ where: { id } });
  if (!launch || launch.provider !== 'METEORA' || launch.userId !== userId || launch.network !== meteoraNetwork()) throw new HttpError(404, 'Launch not found.');
  return launch;
}
export async function assertLaunchActions(rpc: Connection) {
  assertMeteoraEnabled(); await assertMeteoraNetwork(rpc);
  const settings = await db.settings.findUnique({ where: { id: 'global' } });
  if (settings?.launchPaused) throw new HttpError(503, 'New token launches are paused.');
}
export async function prepareMeteoraLaunch(userId: string, input: unknown) {
  const readiness = assertMeteoraEnabled(), data = meteoraLaunchInput.parse(input);
  const rpc = meteoraConnection(); await assertLaunchActions(rpc);
  verifyAsset(data.imageUri, 'logo', userId, data.imageProof);
  const wallet = await db.walletIdentity.findUnique({ where: { userId } });
  if (!wallet) throw new HttpError(403, 'Connect your wallet first.');
  const mint = Keypair.generate(), campaign = Keypair.generate(), configKey = Keypair.generate(), base = Keypair.generate();
  const vault = deriveFeeVaultPdaAddress(base.publicKey, NATIVE_MINT);
  const curve = buildLaunchCurve(readiness.network);
  const metadataUri = await pinMetadata({ name: data.name, symbol: data.symbol.toUpperCase(), description: data.description,
    image: data.imageUri, external_url: data.website || undefined, twitter: data.x || undefined, telegram: data.telegram || undefined });
  const launch = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`launch-prepare:${userId}`}))`;
    if (await tx.tokenLaunch.count({ where: { userId, provider: 'METEORA', status: { in: ['PREPARED','SUBMITTED'] } } }) >= 3)
      throw new HttpError(409, 'Finish or resume your existing launches first.');
    return tx.tokenLaunch.create({ data: {
      userId, provider: 'METEORA', network: readiness.network, creatorAddress: wallet.address,
      mint: mint.publicKey.toBase58(), name: data.name, symbol: data.symbol.toUpperCase(), description: data.description,
      metadataUri, imageUri: data.imageUri, feeAddress: campaign.publicKey.toBase58(),
      feeSecret: encryptSecret(campaign.secretKey, `meteora-campaign:${mint.publicKey}`),
      mintSecret: encryptSecret(mint.secretKey, `meteora-mint:${mint.publicKey}`),
      setupSecrets: { config: encryptSecret(configKey.secretKey, `meteora-config:${mint.publicKey}`),
        base: encryptSecret(base.secretKey, `meteora-base:${mint.publicKey}`) },
      poolConfigAddress: configKey.publicKey.toBase58(), feeVaultAddress: vault.toBase58(),
      poolAddress: deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, configKey.publicKey).toBase58(),
      configuration: { ...readiness.template, vaultBase: base.publicKey.toBase58(), creatorAddress: wallet.address,
        campaignAddress: campaign.publicKey.toBase58(), feeVault: vault.toBase58(), poolConfig: configKey.publicKey.toBase58(),
        nominalCurveSaleUnits: '750000000000000', nominalMigrationBaseUnits: '200000000000000',
        sqrtStartPrice: curve.sqrtStartPrice.toString() },
    } });
  });
  try { return await nextLaunchStep(launch.id, userId); }
  catch (e) {
    // Keep identity and recovery link even when RPC, simulation or wallet funding fails.
    return { ...publicMeteoraLaunch(launch), step: null, completed: 0, error: e instanceof HttpError ? e.message : 'Launch setup temporarily unavailable. Resume the saved launch to retry.' };
  }
}
export function publicMeteoraLaunch(launch: TokenLaunch) {
  return { id: launch.id, provider: launch.provider, network: launch.network, mint: launch.mint,
    name: launch.name, symbol: launch.symbol, status: launch.status, migrationStatus: launch.migrationStatus,
    raidId: launch.raidId, signature: launch.signature, feeAddress: launch.feeAddress,
    feeVaultAddress: launch.feeVaultAddress, poolAddress: launch.poolAddress,
    configuration: launch.configuration, error: launch.error };
}
export async function nextLaunchStep(id: string, userId: string) {
  let launch = await ownedLaunch(id, userId);
  const rpc = meteoraConnection(); await assertMeteoraNetwork(rpc);
  if (launch.status === 'LIVE') return { ...publicMeteoraLaunch(launch), step: null };
  if (launch.status === 'PAUSED') throw new HttpError(409, launch.error || 'Launch paused for review.');
  const existing = await db.launchStep.findMany({ where: { launchId: id, kind: 'SETUP' } });
  for (const step of existing.filter(s => s.status === 'SUBMITTED')) await rebroadcastStep(rpc, step.id);
  const steps = await db.launchStep.findMany({ where: { launchId: id, kind: 'SETUP' } });
  const pending = steps.find(s => s.status === 'SUBMITTED');
  if (pending) return { ...publicMeteoraLaunch(launch), step: publicStep(pending), completed: steps.filter(s => s.status === 'CONFIRMED').length };
  if (['vault','config','pool'].every(key => steps.some(s => s.key === key && s.status === 'CONFIRMED'))) {
    await verifyLaunchChain(launch, rpc);
    launch = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`launch:${id}`}))`;
      const current = await tx.tokenLaunch.findUniqueOrThrow({ where: { id } });
      if (current.raidId) return current;
      await tx.token.upsert({ where: { mint: launch.mint }, create: { mint: launch.mint, name: launch.name, symbol: launch.symbol, imageUri: launch.imageUri }, update: {} });
      const raid = await tx.raid.create({ data: {
        creatorId: userId, tokenLaunchId: id, mint: launch.mint, projectName: launch.name, projectSymbol: launch.symbol,
        tag: `raid_${randomBytes(5).toString('hex')}`, title: `${launch.name} launch raid`, description: launch.description,
        imageUri: launch.imageUri, fundingAsset: 'LAUNCH', fundingNetwork: launch.network, fundingStatus: 'PENDING',
        trackingVersion: 2, ruleVersion: 4, scoringVersion: 2, officialHandle: process.env.X_OFFICIAL_HANDLE || 'useRAID',
        startsAt: new Date(), endsAt: new Date(Date.now()+86400000), impressionTarget: 10000,
      } });
      return tx.tokenLaunch.update({ where: { id }, data: { status: 'LIVE', raidId: raid.id,
        signature: steps.find(s => s.key === 'pool')!.signature, error: null } });
    });
    return { ...publicMeteoraLaunch(launch), step: null, completed: 3 };
  }
  await assertLaunchActions(rpc);
  const secrets = launch.setupSecrets as { config: string; base: string };
  const key = ['vault','config','pool'].find(k => !steps.some(s => s.key === k && s.status === 'CONFIRMED'))!;
  const payer = new PublicKey(launch.creatorAddress!);
  const dbc = new DynamicBondingCurveClient(rpc, 'finalized'), dfs = new DynamicFeeSharingClient(rpc, 'finalized');
  const mint = Keypair.fromSecretKey(decryptSecret(launch.mintSecret, `meteora-mint:${launch.mint}`));
  const configKey = Keypair.fromSecretKey(decryptSecret(secrets.config, `meteora-config:${launch.mint}`));
  const base = Keypair.fromSecretKey(decryptSecret(secrets.base, `meteora-base:${launch.mint}`));
  let transaction, signers: Keypair[], label: string;
  if (key === 'vault') {
    transaction = await dfs.createFeeVaultPda({ base: base.publicKey, owner: base.publicKey, payer,
      tokenMint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ID,
      userShare: [{ address: payer, share: 80 }, { address: new PublicKey(launch.feeAddress), share: 20 }] });
    signers = [base]; label = 'Create creator and community fee vault';
  } else if (key === 'config') {
    transaction = await dbc.partner.createConfig({ ...buildLaunchCurve(launch.network as 'devnet'|'mainnet'),
      config: configKey.publicKey, payer, quoteMint: NATIVE_MINT,
      feeClaimer: new PublicKey(launch.feeVaultAddress!), leftoverReceiver: new PublicKey(launch.feeAddress) });
    signers = [configKey]; label = 'Lock launch economics';
  } else {
    transaction = await dbc.creator.createPool({ config: configKey.publicKey, baseMint: mint.publicKey,
      payer, poolCreator: payer, name: launch.name, symbol: launch.symbol, uri: launch.metadataUri });
    signers = [mint]; label = 'Launch token on bonding curve';
  }
  const step = await prepareStep(rpc, id, key, 'SETUP', label, payer, transaction, signers);
  const fee = await rpc.getFeeForMessage(transaction.compileMessage(), 'finalized');
  const simulation = await rpc.simulateTransaction(transaction);
  const accountRent = await rpc.getMinimumBalanceForRentExemption(key === 'pool' ? 2400 : 1500);
  if (simulation.value.err) {
    if (await rpc.getBalance(payer, 'finalized') < accountRent + (fee.value || 5000))
      throw new HttpError(409, 'Insufficient SOL for launch accounts and network fees. Fund wallet, then resume.');
    throw new HttpError(409, 'Launch simulation failed. No transaction was sent. Check configuration and resume.');
  }
  return { ...publicMeteoraLaunch(launch), step: publicStep(step), completed: steps.filter(s=>s.status==='CONFIRMED').length,
    estimatedLamports: accountRent + (fee.value || 5000), estimateLabel: 'Estimated account rent and network fee for this step' };
}
export function publicStep(step: { id: string; key: string; label: string; status: string; transaction: string|null; signature: string|null; error: string|null }) {
  return { id: step.id, key: step.key, label: step.label, status: step.status,
    transaction: step.status === 'PLANNED' ? step.transaction : null, signature: step.signature, error: step.error };
}
export async function submitMeteoraLaunch(id: string, userId: string, stepId: string, raw: string) {
  const launch = await ownedLaunch(id, userId), rpc = meteoraConnection();
  await assertLaunchActions(rpc);
  const step = await db.launchStep.findUnique({ where: { id: stepId } });
  if (!step || step.launchId !== id || step.kind !== 'SETUP') throw new HttpError(404, 'Launch step not found.');
  const wallet = await db.walletIdentity.findUniqueOrThrow({ where: { userId } });
  if (wallet.address !== launch.creatorAddress) throw new HttpError(403, 'Original creator wallet required.');
  await submitStep(rpc, step.id, raw, wallet.address);
  return nextLaunchStep(id, userId);
}
