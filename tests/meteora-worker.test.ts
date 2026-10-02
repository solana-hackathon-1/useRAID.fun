import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { LaunchCampaignPayout, LaunchStep, TokenLaunch } from '@prisma/client';
import BN from 'bn.js';
import bs58 from 'bs58';

const mocks = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    tokenLaunch: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    launchStep: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    launchCampaignPayout: {
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    launchCampaignBudget: { update: vi.fn() },
    launchBalanceEntry: { findUnique: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
    settings: { findUnique: vi.fn() },
  },
  rpc: {
    getBalance: vi.fn(),
    getAccountInfo: vi.fn(),
    getParsedTransaction: vi.fn(),
    getSignaturesForAddress: vi.fn(),
  },
  refresh: vi.fn(),
  balance: vi.fn(),
  lock: vi.fn(),
  prepare: vi.fn(),
  submit: vi.fn(),
  rebroadcast: vi.fn(),
  decrypt: vi.fn(),
  readiness: vi.fn(),
  network: vi.fn(),
  assertNetwork: vi.fn(),
  settlement: vi.fn(),
  pool: vi.fn(),
  poolConfig: vi.fn(),
  feeBreakdown: vi.fn(),
  fundDbc: vi.fn(),
  fundDamm: vi.fn(),
  tokenAccount: vi.fn(),
  config: { liveApproved: true },
}));

vi.mock('../src/lib/db', () => ({ db: mocks.db }));
vi.mock('../src/lib/config', () => ({
  config: mocks.config,
  trackingSettlementEnabled: mocks.settlement,
}));
vi.mock('../src/lib/launch-crypto', () => ({ decryptSecret: mocks.decrypt }));
vi.mock('../src/lib/meteora/config', () => ({
  meteoraNetwork: mocks.network,
  meteoraConnection: () => mocks.rpc,
  assertMeteoraNetwork: mocks.assertNetwork,
  meteoraReadiness: mocks.readiness,
}));
vi.mock('../src/lib/meteora/state', () => ({ refreshLaunchState: mocks.refresh }));
vi.mock('../src/lib/meteora/campaigns', () => ({
  launchBalance: mocks.balance,
  lockLaunchBalance: mocks.lock,
}));
vi.mock('../src/lib/meteora/transactions', () => ({
  prepareStep: mocks.prepare,
  submitStep: mocks.submit,
  rebroadcastStep: mocks.rebroadcast,
}));
vi.mock('@solana/spl-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/spl-token')>()),
  getAccount: mocks.tokenAccount,
}));
vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@meteora-ag/dynamic-bonding-curve-sdk')>()),
  DynamicBondingCurveClient: class {
    state = { getPool: mocks.pool, getPoolConfig: mocks.poolConfig };
  },
}));
vi.mock('@meteora-ag/dynamic-fee-sharing-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@meteora-ag/dynamic-fee-sharing-sdk')>()),
  DynamicFeeSharingClient: class {
    getFeeBreakdown = mocks.feeBreakdown;
    fundByClaimDbcPartnerTradingFee2 = mocks.fundDbc;
    fundByClaimDammV2Fee = mocks.fundDamm;
  },
}));

import { financeMeteoraLaunch } from '../src/lib/meteora/worker';

type TestLaunch = TokenLaunch & { user: { suspended: boolean } };
type Entry = {
  key: string;
  asset: string;
  kind: string;
  availableDelta: bigint;
  reservedDelta: bigint;
  signature: string;
};
let launch: TestLaunch;
let campaign: Keypair;
let operator: Keypair;
let payouts: LaunchCampaignPayout[];
let steps: LaunchStep[];
let entries: Map<string, Entry>;

function payoutRow(status = 'APPROVED'): LaunchCampaignPayout {
  return {
    id: 'reward-1',
    launchId: launch.id,
    raidId: 'raid-1',
    asset: 'SOL',
    network: launch.network,
    walletAddress: Keypair.generate().publicKey.toBase58(),
    xId: 'raider',
    units: 1_000_000_000n,
    status,
    approvedBy: 'admin',
    approvedAt: new Date(),
    signature: null,
    paidAt: null,
  };
}
function signedPayout(row: LaunchCampaignPayout): LaunchStep {
  return {
    id: 'step-1',
    key: `payout:${row.id}`,
    launchId: launch.id,
    kind: 'PAYOUT',
    status: 'SUBMITTED',
    label: 'Approved payout',
    payer: operator.publicKey.toBase58(),
    transaction: null,
    messageHash: null,
    blockhash: null,
    lastValidBlockHeight: null,
    error: null,
    expiresAt: null,
    createdAt: new Date(),
    confirmedAt: null,
    signature: 'signed-transfer',
    metadata: {
      payoutId: row.id,
      asset: row.asset,
      units: row.units.toString(),
      recipient: row.walletAddress,
    },
  };
}
function reserveReceipt(mutation?: 'pool' | 'recipient' | 'failed' | 'excess') {
  const mint = new PublicKey(launch.mint),
    receiver = campaign.publicKey;
  const destination = getAssociatedTokenAddressSync(mint, receiver),
    source = Keypair.generate().publicKey;
  const units = 50_000_000_000_000n + (mutation === 'excess' ? 1n : 0n);
  const accounts = [
    Keypair.generate().publicKey,
    new PublicKey(launch.poolConfigAddress!),
    mutation === 'pool' ? Keypair.generate().publicKey : new PublicKey(launch.poolAddress!),
    destination,
    source,
    mint,
    mutation === 'recipient' ? Keypair.generate().publicKey : receiver,
    TOKEN_PROGRAM_ID,
  ];
  return {
    meta: {
      err: mutation === 'failed' ? { InstructionError: [0, 'Custom'] } : null,
      preTokenBalances: [
        { accountIndex: 1, mint: launch.mint, uiTokenAmount: { amount: units.toString() } },
      ],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint: launch.mint,
          owner: launch.feeAddress,
          uiTokenAmount: { amount: units.toString() },
        },
        { accountIndex: 1, mint: launch.mint, uiTokenAmount: { amount: '0' } },
      ],
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: destination }, { pubkey: source }],
        instructions: [
          {
            programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
            accounts,
            data: bs58.encode(
              Uint8Array.from(
                DynamicBondingCurveIdl.instructions.find((i) => i.name === 'withdraw_leftover')!
                  .discriminator,
              ),
            ),
          },
        ],
      },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  operator = Keypair.generate();
  campaign = Keypair.generate();
  launch = {
    id: 'launch-1',
    provider: 'METEORA',
    network: 'devnet',
    status: 'LIVE',
    user: { suspended: false },
    mint: Keypair.generate().publicKey.toBase58(),
    feeAddress: campaign.publicKey.toBase58(),
    feeSecret: 'encrypted',
    feeVaultAddress: Keypair.generate().publicKey.toBase58(),
    poolAddress: Keypair.generate().publicKey.toBase58(),
    poolConfigAddress: Keypair.generate().publicKey.toBase58(),
    migrationStatus: 'BONDING',
  } as TestLaunch;
  payouts = [];
  steps = [];
  entries = new Map();
  mocks.config.liveApproved = true;
  vi.stubEnv('METEORA_OPERATOR_SECRET_KEY', bs58.encode(operator.secretKey));
  vi.stubEnv('METEORA_OPERATOR_PUBLIC_KEY', operator.publicKey.toBase58());
  vi.stubEnv('METEORA_PAYOUT_ENABLED', 'true');
  vi.stubEnv('METEORA_COLLECTION_ENABLED', 'false');
  mocks.network.mockImplementation(() => launch.network);
  mocks.readiness.mockReturnValue({ issues: [] });
  mocks.settlement.mockReturnValue(true);
  mocks.decrypt.mockReturnValue(campaign.secretKey);
  mocks.db.$transaction.mockImplementation(async (callback) => callback(mocks.db));
  mocks.db.tokenLaunch.findUniqueOrThrow.mockImplementation(async () => launch);
  mocks.db.tokenLaunch.update.mockImplementation(async ({ data }) => Object.assign(launch, data));
  mocks.db.launchStep.findMany.mockImplementation(async () =>
    steps.filter((s) => ['SUBMITTED', 'CONFIRMED'].includes(s.status)),
  );
  mocks.db.launchStep.findUnique.mockImplementation(
    async ({ where }) => steps.find((s) => s.key === where.launchId_key.key) || null,
  );
  mocks.db.launchStep.findFirst.mockResolvedValue(null);
  mocks.db.launchCampaignPayout.findMany.mockImplementation(async () =>
    payouts.filter((p) => ['APPROVED', 'SUBMITTED'].includes(p.status)),
  );
  mocks.db.launchCampaignPayout.findUniqueOrThrow.mockImplementation(async ({ where }) =>
    payouts.find((p) => p.id === where.id),
  );
  mocks.db.launchCampaignPayout.update.mockImplementation(async ({ where, data }) =>
    Object.assign(
      payouts.find((p) => p.id === where.id)!,
      data,
    ),
  );
  mocks.db.launchCampaignPayout.updateMany.mockImplementation(async ({ where, data }) => {
    const row = payouts.find((p) => p.id === where.id && p.status !== 'PAID');
    if (row) Object.assign(row, data);
    return { count: row ? 1 : 0 };
  });
  mocks.db.settings.findUnique.mockResolvedValue({ payoutPaused: false, collectionEnabled: true });
  mocks.db.launchBalanceEntry.findUnique.mockImplementation(
    async ({ where }) => entries.get(where.key) || null,
  );
  mocks.db.launchBalanceEntry.create.mockImplementation(async ({ data }) => {
    if (entries.has(data.key)) throw new Error('Duplicate ledger entry');
    entries.set(data.key, data);
    return data;
  });
  mocks.balance.mockImplementation(async (_id, asset) => ({
    available: [...entries.values()]
      .filter((e) => e.asset === asset)
      .reduce((n, e) => n + e.availableDelta, 0n),
    reserved: 0n,
  }));
  mocks.refresh.mockResolvedValue({ phase: 'BONDING', reserveWithdrawn: false });
  mocks.rpc.getBalance.mockResolvedValue(10_000_000_000);
  mocks.rpc.getAccountInfo.mockResolvedValue(null);
  mocks.tokenAccount.mockResolvedValue({ amount: 50_000_000_000_000n });
  mocks.pool.mockResolvedValue({
    poolState: { partnerQuoteFee: new BN(0), isWithdrawLeftover: false },
  });
  mocks.poolConfig.mockResolvedValue({
    swapBaseAmount: new BN('750000000000000'),
    migrationBaseThreshold: new BN('200000000000000'),
  });
  mocks.feeBreakdown.mockImplementation(async () => ({
    userFees: [
      {
        address: campaign.publicKey,
        feeUnclaimed: new BN(0),
        totalFee: new BN(0),
        feeClaimed: new BN(0),
      },
    ],
  }));
  mocks.rebroadcast.mockImplementation(async (_rpc, id) => steps.find((s) => s.id === id));
  mocks.prepare.mockImplementation(
    async (_rpc, launchId, key, kind, label, payer, transaction, signers, metadata) => {
      transaction.feePayer = payer;
      transaction.recentBlockhash = Keypair.generate().publicKey.toBase58();
      const required = transaction
        .compileMessage()
        .accountKeys.slice(0, transaction.compileMessage().header.numRequiredSignatures);
      const included = signers.filter((signer: Keypair) =>
        required.some((k: PublicKey) => k.equals(signer.publicKey)),
      );
      if (included.length) transaction.partialSign(...included);
      const step = {
        id: `step-${steps.length + 1}`,
        launchId,
        key,
        kind,
        label,
        payer: payer.toBase58(),
        metadata,
        status: 'PLANNED',
        transaction: transaction.serialize({ requireAllSignatures: false }).toString('base64'),
      } as LaunchStep;
      steps.push(step);
      return step;
    },
  );
  mocks.submit.mockImplementation(async (_rpc, id, raw) => {
    expect(Transaction.from(Buffer.from(raw, 'base64')).verifySignatures()).toBe(true);
    const step = steps.find((s) => s.id === id)!;
    Object.assign(step, { status: 'SUBMITTED', signature: 'new-transfer', transaction: raw });
    return step;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('Meteora worker financial regressions', () => {
  it('records finalized signed payout while launch, release switches, and smaller limits are paused', async () => {
    launch.network = 'mainnet';
    launch.status = 'PAUSED';
    launch.user.suspended = true;
    const row = payoutRow('HELD'),
      step = signedPayout(row);
    payouts.push(row);
    steps.push(step);
    vi.stubEnv('METEORA_PAYOUT_ENABLED', 'false');
    vi.stubEnv('METEORA_MAX_PAYOUT_SOL', '0.001');
    mocks.settlement.mockReturnValue(false);
    mocks.config.liveApproved = false;
    mocks.db.settings.findUnique.mockResolvedValue({
      payoutPaused: true,
      collectionEnabled: false,
    });
    mocks.readiness.mockReturnValue({ issues: ['Mainnet pilot is not approved.'] });
    mocks.rebroadcast.mockImplementation(async () => ({ ...step, status: 'CONFIRMED' }));
    await financeMeteoraLaunch(launch.id);
    await financeMeteoraLaunch(launch.id);
    expect(row.status).toBe('PAID');
    expect(row.signature).toBe('signed-transfer');
    expect(entries.get(`paid:${row.id}`)?.reservedDelta).toBe(-row.units);
    expect(mocks.db.launchBalanceEntry.create).toHaveBeenCalledTimes(1);
    expect(mocks.db.launchCampaignBudget.update).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('retains pending signed payout without paying again or comparing unreconciled liabilities', async () => {
    launch.status = 'PAUSED';
    const row = payoutRow('HELD');
    payouts.push(row);
    steps.push(signedPayout(row));
    vi.stubEnv('METEORA_PAYOUT_ENABLED', 'false');
    await financeMeteoraLaunch(launch.id);
    expect(row.status).toBe('SUBMITTED');
    expect(row.signature).toBe('signed-transfer');
    expect(entries.size).toBe(0);
    expect(mocks.balance).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each(['paused', 'suspended', 'mainnet gate', 'settlement', 'collection'] as const)(
    'refuses new payouts when %s',
    async (condition) => {
      payouts.push(payoutRow());
      if (condition === 'paused') launch.status = 'PAUSED';
      if (condition === 'suspended') launch.user.suspended = true;
      if (condition === 'mainnet gate')
        mocks.readiness.mockReturnValue({ issues: ['Mainnet pilot is not approved.'] });
      if (condition === 'settlement') mocks.settlement.mockReturnValue(false);
      if (condition === 'collection')
        mocks.db.settings.findUnique.mockResolvedValue({
          payoutPaused: false,
          collectionEnabled: false,
        });
      await financeMeteoraLaunch(launch.id);
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(payouts[0].status).toBe('APPROVED');
    },
  );

  it('refuses new payout when verified onchain configuration mismatches', async () => {
    payouts.push(payoutRow());
    mocks.refresh.mockRejectedValue(new Error('Onchain launch configuration mismatch.'));
    await expect(financeMeteoraLaunch(launch.id)).rejects.toThrow('configuration mismatch');
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('pauses uncovered campaign liabilities before issuing any new payout', async () => {
    payouts.push(payoutRow());
    mocks.balance.mockResolvedValue({ available: 11_000_000_000n, reserved: 1_000_000_000n });
    await expect(financeMeteoraLaunch(launch.id)).rejects.toThrow('accounting mismatch');
    expect(launch.status).toBe('PAUSED');
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each(['DBC', 'DAMM'] as const)(
    'sponsors %s collection ATA rent from operator and retains campaign signature',
    async (phase) => {
      vi.stubEnv('METEORA_COLLECTION_ENABLED', 'true');
      mocks.rpc.getBalance.mockImplementation(async (address: PublicKey) =>
        address.equals(campaign.publicKey) ? 0 : 1_000_000_000,
      );
      mocks.pool.mockResolvedValue({
        poolState: {
          partnerQuoteFee: new BN(phase === 'DBC' ? 100 : 0),
          isWithdrawLeftover: phase === 'DAMM',
        },
      });
      if (phase === 'DAMM') {
        launch.migrationStatus = 'GRADUATED';
        launch.configuration = { vaultBase: Keypair.generate().publicKey.toBase58() };
        launch.dammPoolAddress = Keypair.generate().publicKey.toBase58();
        launch.positionAddress = Keypair.generate().publicKey.toBase58();
        launch.positionNftAccount = Keypair.generate().publicKey.toBase58();
      }
      mocks[phase === 'DBC' ? 'fundDbc' : 'fundDamm'].mockImplementation(async () => {
        const mint = new PublicKey(launch.mint),
          vault = new PublicKey(launch.feeVaultAddress!);
        return new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(
            campaign.publicKey,
            getAssociatedTokenAddressSync(mint, vault, true),
            vault,
            mint,
          ),
          new TransactionInstruction({
            programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
            keys: [{ pubkey: campaign.publicKey, isSigner: true, isWritable: false }],
            data: Buffer.from([1]),
          }),
        );
      });
      await financeMeteoraLaunch(launch.id);
      expect(mocks.submit).toHaveBeenCalledTimes(1);
      const transaction = Transaction.from(Buffer.from(mocks.submit.mock.calls[0][2], 'base64'));
      const ata = transaction.instructions.find((i) =>
        i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
      )!;
      expect(ata.keys[0].pubkey.equals(operator.publicKey)).toBe(true);
      expect(transaction.feePayer?.equals(operator.publicKey)).toBe(true);
      expect(
        transaction.signatures.find((s) => s.publicKey.equals(campaign.publicKey))?.signature,
      ).toBeTruthy();
      expect(entries.size).toBe(0);
    },
  );

  it('credits externally withdrawn reserve once with exact finalized receipt', async () => {
    mocks.refresh.mockResolvedValue({ phase: 'GRADUATED', reserveWithdrawn: true });
    mocks.rpc.getSignaturesForAddress.mockResolvedValue([
      { signature: 'external-withdrawal', err: null },
    ]);
    mocks.rpc.getParsedTransaction.mockResolvedValue(reserveReceipt());
    mocks.rpc.getAccountInfo.mockResolvedValue({});
    await financeMeteoraLaunch(launch.id);
    await financeMeteoraLaunch(launch.id);
    expect(entries.get(`reserve-credit:${launch.id}`)).toMatchObject({
      asset: launch.mint,
      availableDelta: 50_000_000_000_000n,
      signature: 'external-withdrawal',
      kind: 'RESERVE_RECEIPT',
    });
    expect(mocks.db.launchBalanceEntry.create).toHaveBeenCalledTimes(1);
    expect(mocks.rpc.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });

  it('accepts SDK-accounted reserve dust beyond nominal 50M', async () => {
    mocks.refresh.mockResolvedValue({ phase: 'GRADUATED', reserveWithdrawn: true });
    mocks.poolConfig.mockResolvedValue({
      swapBaseAmount: new BN('749999999999999'),
      migrationBaseThreshold: new BN('200000000000000'),
    });
    mocks.rpc.getSignaturesForAddress.mockResolvedValue([
      { signature: 'rounded-withdrawal', err: null },
    ]);
    mocks.rpc.getParsedTransaction.mockResolvedValue(reserveReceipt('excess'));
    mocks.rpc.getAccountInfo.mockResolvedValue({});
    mocks.tokenAccount.mockResolvedValue({ amount: 50_000_000_000_001n });
    await financeMeteoraLaunch(launch.id);
    expect(entries.get(`reserve-credit:${launch.id}`)?.availableDelta).toBe(50_000_000_000_001n);
  });

  it.each(['pool', 'recipient', 'failed', 'excess'] as const)(
    'rejects external reserve receipt with wrong %s',
    async (mutation) => {
      mocks.refresh.mockResolvedValue({ phase: 'GRADUATED', reserveWithdrawn: true });
      mocks.rpc.getSignaturesForAddress.mockResolvedValue([
        { signature: 'invalid-withdrawal', err: null },
      ]);
      mocks.rpc.getParsedTransaction.mockResolvedValue(reserveReceipt(mutation));
      await expect(financeMeteoraLaunch(launch.id)).rejects.toThrow(
        'withdrawal receipt unavailable',
      );
      expect(entries.size).toBe(0);
      expect(mocks.submit).not.toHaveBeenCalled();
    },
  );
});
