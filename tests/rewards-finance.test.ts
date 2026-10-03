import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { TokenLaunch } from '@prisma/client';
import { decodeTransfers, FakeRpc } from './helpers/fake-solana';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

const mocks = vi.hoisted(() => ({
  rpc: null as unknown,
  curve: vi.fn(),
  pool: vi.fn(),
  collect: vi.fn(),
}));
vi.mock('../src/lib/release', () => ({
  launchpadsAvailable: true,
  assertLaunchpadsAvailable: () => {},
}));
vi.mock('../src/lib/pump-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pump-launch')>()),
  connection: () => mocks.rpc,
}));
vi.mock('../src/lib/pump-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/pump-sdk')>();
  return {
    ...original,
    PUMP_SDK: { decodeBondingCurve: mocks.curve },
    getPumpAmmProgram: () => ({ account: { pool: { fetchNullable: mocks.pool } } }),
    OnlinePumpSdk: class {
      collectCoinCreatorFeeV2Instructions = mocks.collect;
    },
  };
});
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { sealSecret, generateSealKeyPair, encryptSecret } from '../src/lib/launch-crypto';
import { FinancePauseError, __test, financeLaunch, settleNextRound } from '../src/lib/rewards';
import {
  PUMP_PROGRAM_ID,
  bondingCurvePda,
  creatorVaultPda,
  ammCreatorVaultPda,
} from '../src/lib/pump-sdk';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const names = [
  'OPERATOR_SECRET_KEY',
  'OPERATOR_PUBLIC_KEY',
  'PLATFORM_TREASURY_ADDRESS',
  'PAYOUT_ENABLED',
  'SOLANA_RPC_URL',
  'LAUNCH_KEY_1',
  'FEE_SEAL_PUBLIC_1',
  'FEE_SEAL_PRIVATE_1',
] as const;
const previousEnv = Object.fromEntries(names.map((n) => [n, process.env[n]]));
const operator = Keypair.generate();
const treasury = Keypair.generate();
const COST = 10_000;

suite('launch finance', () => {
  let rpc: FakeRpc;
  let launch: TokenLaunch;
  let fee: Keypair;
  let mint: Keypair;
  let userId: string;
  beforeAll(async () => {
    assertTestDatabase();
    await truncateAll(db);
    config.demo = false;
    config.liveApproved = true;
    process.env.OPERATOR_SECRET_KEY = bs58.encode(operator.secretKey);
    process.env.OPERATOR_PUBLIC_KEY = operator.publicKey.toBase58();
    process.env.PLATFORM_TREASURY_ADDRESS = treasury.publicKey.toBase58();
    process.env.PAYOUT_ENABLED = 'true';
    process.env.SOLANA_RPC_URL = 'https://rpc.example';
    process.env.LAUNCH_KEY_1 = Buffer.alloc(32, 5).toString('base64');
    const pair = generateSealKeyPair();
    process.env.FEE_SEAL_PUBLIC_1 = pair.publicKey;
    process.env.FEE_SEAL_PRIVATE_1 = pair.privateKey;
  });
  afterAll(async () => {
    for (const n of names)
      if (previousEnv[n] === undefined) delete process.env[n];
      else process.env[n] = previousEnv[n];
    await db.$disconnect();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    // A full TRUNCATE costs seconds per test, so clear only the tables these fixtures touch.
    await db.post.deleteMany();
    await db.rewardEnrollment.deleteMany();
    await db.rewardPayout.deleteMany();
    await db.rewardRound.deleteMany();
    await db.feeClaim.deleteMany();
    await db.financialTx.deleteMany();
    await db.raid.deleteMany();
    await db.tokenLaunch.deleteMany();
    await db.settings.deleteMany();
    await db.user.deleteMany();
    rpc = new FakeRpc();
    mocks.rpc = rpc;
    fee = Keypair.generate();
    mint = Keypair.generate();
    const user = await db.user.create({
      data: { xId: 'finance-owner', handle: 'f', approved: true },
    });
    userId = user.id;
    await db.settings.create({ data: { id: 'global', collectionEnabled: true } });
    launch = await db.tokenLaunch.create({
      data: {
        userId,
        mint: mint.publicKey.toBase58(),
        name: 'Token',
        symbol: 'TKN',
        description: 'A launch fixture token',
        metadataUri: 'ipfs://x',
        imageUri: 'ipfs://y',
        feeAddress: fee.publicKey.toBase58(),
        feeSecret: sealSecret(fee.secretKey, `fee:${mint.publicKey}`),
        mintSecret: encryptSecret(mint.secretKey, `mint:${mint.publicKey}`),
        status: 'LIVE',
      },
    });
    mocks.curve.mockReturnValue({
      creator: fee.publicKey,
      isHolderReward: false,
      isMayhemMode: false,
      quoteMint: PublicKey.default,
      complete: false,
    });
    rpc.accounts.set(bondingCurvePda(mint.publicKey).toBase58(), {
      data: Buffer.alloc(8),
      owner: PUMP_PROGRAM_ID,
    });
  });

  const round = async (platformLamports = 0n) =>
    db.rewardRound.create({
      data: {
        launchId: launch.id,
        raidId: 'raid-fixture',
        startsAt: new Date(Date.now() - 7200000),
        endsAt: new Date(Date.now() - 3600000),
        status: 'READY',
        platformLamports,
      },
    });
  const payout = async (
    roundId: string,
    lamports: bigint,
    wallet = Keypair.generate().publicKey.toBase58(),
  ) =>
    db.rewardPayout.create({
      data: {
        launchId: launch.id,
        roundId,
        payoutBatchRoundId: roundId,
        walletAddress: wallet,
        xId: `x-${wallet.slice(0, 6)}`,
        score: 100,
        lamports,
        status: 'READY',
      },
    });
  const fund = (lamports: number) => rpc.balances.set(fee.publicKey.toBase58(), lamports);
  const signedTx = async (
    kind: 'CLAIM' | 'PAYOUT' | 'PLATFORM',
    data: { roundId?: string; ageMs?: number; cost?: bigint; signature?: string } = {},
  ) =>
    db.financialTx.create({
      data: {
        key: `${kind}:${Math.random()}`,
        launchId: launch.id,
        roundId: data.roundId,
        raidId: null,
        kind,
        raw: Buffer.from('raw').toString('base64'),
        signature: data.signature ?? `sig-${Math.random()}`,
        blockhash: rpc.blockhash,
        lastValidBlockHeight: rpc.lastValidBlockHeight,
        costLamports: data.cost ?? BigInt(COST),
        createdAt: new Date(Date.now() - (data.ageMs ?? 600000)),
      },
    });
  const launchRow = () => db.tokenLaunch.findUniqueOrThrow({ where: { id: launch.id } });
  const finalizedTx = (
    signature: string,
    meta: Record<string, unknown>,
    keys: PublicKey[] = [],
  ) => {
    rpc.statuses.set(signature, { confirmationStatus: 'finalized', err: null });
    rpc.transactions.set(signature, {
      meta: { err: null, fee: COST, preBalances: [], postBalances: [], ...meta },
      transaction: { message: { staticAccountKeys: keys } },
    });
  };

  describe('signed transaction resolution', () => {
    it('expires a signed payout past the confirmation margin and releases its rows', async () => {
      const r = await round();
      const p = await payout(r.id, 2_000_000n);
      const tx = await signedTx('PAYOUT', { roundId: r.id });
      await db.rewardPayout.update({
        where: { id: p.id },
        data: { status: 'SENT', signature: tx.signature },
      });
      rpc.blockHeight = rpc.lastValidBlockHeight + 151;
      expect(await __test.reconcileFinancial(rpc.asConnection(), launch)).toBe(true);
      expect((await db.financialTx.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe(
        'EXPIRED',
      );
      expect(await db.rewardPayout.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({
        status: 'READY',
        signature: null,
      });
      expect((await launchRow()).status).toBe('LIVE');
    });
    it('keeps rebroadcasting inside the margin and waits for young transactions', async () => {
      const tx = await signedTx('CLAIM');
      rpc.blockHeight = rpc.lastValidBlockHeight + 50;
      expect(await __test.reconcileFinancial(rpc.asConnection(), launch)).toBe(true);
      expect(rpc.sent).toHaveLength(1);
      expect((await db.financialTx.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe(
        'SIGNED',
      );
      await db.financialTx.update({ where: { id: tx.id }, data: { createdAt: new Date() } });
      rpc.blockHeight = rpc.lastValidBlockHeight + 500;
      await __test.reconcileFinancial(rpc.asConnection(), launch);
      expect((await db.financialTx.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe(
        'SIGNED',
      );
    });
    it('confirms instead of expiring when the transaction landed without a status', async () => {
      const r = await round();
      const p = await payout(r.id, 2_000_000n);
      const tx = await signedTx('PAYOUT', { roundId: r.id });
      await db.rewardPayout.update({
        where: { id: p.id },
        data: { status: 'SENT', signature: tx.signature },
      });
      rpc.blockHeight = rpc.lastValidBlockHeight + 500;
      rpc.transactions.set(tx.signature, { meta: { err: null, fee: COST } });
      expect(await __test.reconcileFinancial(rpc.asConnection(), launch)).toBe(false);
      expect((await db.financialTx.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe(
        'CONFIRMED',
      );
      expect((await db.rewardPayout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
        'PAID',
      );
    });
    it('records a fee mismatch as confirmed, pauses once, and does not loop', async () => {
      const r = await round();
      const p = await payout(r.id, 2_000_000n);
      const tx = await signedTx('PAYOUT', { roundId: r.id });
      await db.rewardPayout.update({
        where: { id: p.id },
        data: { status: 'SENT', signature: tx.signature },
      });
      finalizedTx(tx.signature, { fee: COST + 1 });
      expect(await __test.reconcileFinancial(rpc.asConnection(), launch)).toBe(true);
      expect((await db.financialTx.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe(
        'CONFIRMED',
      );
      expect((await db.rewardPayout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
        'PAID',
      );
      const paused = await launchRow();
      expect(paused.status).toBe('PAUSED');
      expect(paused.error).toMatch(/differed from approved/);
      expect(await __test.reconcileFinancial(rpc.asConnection(), launch)).toBe(false);
    });
    it('charges a failed payout to its round and returns the rows to READY', async () => {
      const r = await round();
      const p = await payout(r.id, 2_000_000n);
      const tx = await signedTx('PAYOUT', { roundId: r.id });
      await db.rewardPayout.update({
        where: { id: p.id },
        data: { status: 'SENT', signature: tx.signature },
      });
      rpc.statuses.set(tx.signature, {
        confirmationStatus: 'finalized',
        err: { InstructionError: 1 },
      });
      rpc.transactions.set(tx.signature, { meta: { err: { InstructionError: 1 }, fee: COST } });
      expect(await __test.reconcileFinancial(rpc.asConnection(), launch)).toBe(true);
      expect(
        await db.feeClaim.findUniqueOrThrow({ where: { signature: tx.signature } }),
      ).toMatchObject({
        roundId: r.id,
        source: 'failed-network-cost',
      });
      expect((await db.rewardPayout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe(
        'READY',
      );
      expect((await launchRow()).status).toBe('PAUSED');
    });
    it('keeps the round empty for a failed claim', async () => {
      const tx = await signedTx('CLAIM');
      rpc.statuses.set(tx.signature, {
        confirmationStatus: 'finalized',
        err: { InstructionError: 0 },
      });
      rpc.transactions.set(tx.signature, { meta: { err: { InstructionError: 0 }, fee: COST } });
      await __test.reconcileFinancial(rpc.asConnection(), launch);
      expect(
        (await db.feeClaim.findUniqueOrThrow({ where: { signature: tx.signature } })).roundId,
      ).toBeNull();
    });
  });

  describe('fee recipient verification', () => {
    it('treats an uncreated canonical pool as the migration window', async () => {
      mocks.curve.mockReturnValue({ ...mocks.curve(), complete: true });
      mocks.pool.mockResolvedValue(null);
      await expect(__test.verifyFeeRecipient(rpc.asConnection(), launch)).resolves.toMatchObject({
        migrating: true,
      });
    });
    it('pauses when the pool names another creator', async () => {
      mocks.curve.mockReturnValue({ ...mocks.curve(), complete: true });
      mocks.pool.mockResolvedValue({ coinCreator: Keypair.generate().publicKey });
      await expect(__test.verifyFeeRecipient(rpc.asConnection(), launch)).rejects.toBeInstanceOf(
        FinancePauseError,
      );
      mocks.pool.mockResolvedValue({ coinCreator: fee.publicKey });
      await expect(__test.verifyFeeRecipient(rpc.asConnection(), launch)).resolves.toMatchObject({
        migrating: false,
      });
    });
  });

  describe('pausing', () => {
    const readyPayout = async () => {
      const r = await round();
      await payout(r.id, 2_000_000n);
      fund(10_000_000);
    };
    it.each([
      [
        'a changed fee recipient',
        async () => {
          rpc.accounts.set(bondingCurvePda(mint.publicKey).toBase58(), {
            data: Buffer.alloc(8),
            owner: SystemProgram.programId,
          });
        },
        /Fee recipient or bonding curve changed/,
      ],
      [
        'an unexpected network fee',
        async () => {
          await readyPayout();
          rpc.feePerSignature = 200_000;
        },
        /Unexpected network fee/,
      ],
      [
        'a failed simulation',
        async () => {
          await readyPayout();
          rpc.simulationError = { InstructionError: [0, 'Custom'] };
        },
        /simulation failed/,
      ],
      [
        'an insufficient fee wallet balance',
        async () => {
          const r = await round();
          await payout(r.id, 2_000_000n);
          fund(1_000);
        },
        /balance insufficient/,
      ],
      [
        'a negative claim',
        async () => {
          const tx = await signedTx('CLAIM');
          finalizedTx(tx.signature, { preBalances: [5], postBalances: [1] }, [fee.publicKey]);
        },
        /Negative claim/,
      ],
      [
        'a claim that does not credit the fee wallet',
        async () => {
          const tx = await signedTx('CLAIM');
          finalizedTx(tx.signature, {}, [Keypair.generate().publicKey]);
        },
        /recipient missing/,
      ],
    ])('pauses the launch for %s', async (_name, arrange, message) => {
      await arrange();
      await expect(financeLaunch(launch.id)).rejects.toThrow(message);
      const paused = await launchRow();
      expect(paused.status).toBe('PAUSED');
      expect(paused.error).toMatch(message);
    });
    it('does not pause for an RPC failure, and keeps the first pause reason', async () => {
      await readyPayout();
      rpc.getBalance = async () => {
        throw new Error('rpc unavailable');
      };
      await expect(financeLaunch(launch.id)).rejects.toThrow('rpc unavailable');
      expect((await launchRow()).status).toBe('LIVE');
      await db.tokenLaunch.update({
        where: { id: launch.id },
        data: { status: 'PAUSED', error: 'original reason' },
      });
      await __test.reconcileFinancial(rpc.asConnection(), launch);
      expect((await launchRow()).error).toBe('original reason');
    });
    it('reconciles a signed transaction before the recipient check can block it', async () => {
      const tx = await signedTx('CLAIM');
      finalizedTx(tx.signature, { preBalances: [0], postBalances: [3_000_000] }, [fee.publicKey]);
      rpc.accounts.set(bondingCurvePda(mint.publicKey).toBase58(), {
        data: Buffer.alloc(8),
        owner: SystemProgram.programId,
      });
      await expect(financeLaunch(launch.id)).rejects.toThrow(/Fee recipient/);
      expect((await db.financialTx.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe(
        'CONFIRMED',
      );
      expect(await db.feeClaim.count({ where: { launchId: launch.id } })).toBe(1);
      expect((await launchRow()).status).toBe('PAUSED');
      await expect(financeLaunch(launch.id)).resolves.toBeUndefined();
    });
  });

  describe('fee wallet rent floor', () => {
    const FLOOR = 890_880;
    const transfers = () => decodeTransfers(rpc.sent[0]).transfers;
    it.each([
      ['tops up a remainder below the rent floor', 400_000, 490_880],
      ['leaves a zero remainder alone', 0, 0],
      ['leaves a remainder above the floor alone', FLOOR + 1, 0],
    ])('payout %s', async (_name, remainder, topUp) => {
      const r = await round();
      await payout(r.id, 2_000_000n);
      fund(2_000_000 + COST + remainder);
      await __test.payRound(rpc.asConnection(), launch);
      const first = transfers()[0];
      if (topUp) {
        expect(first).toEqual({
          from: operator.publicKey.toBase58(),
          to: fee.publicKey.toBase58(),
          lamports: topUp,
        });
      } else expect(first.from).toBe(fee.publicKey.toBase58());
      expect((await launchRow()).rentReserveLamports).toBe(BigInt(topUp));
    });
    it.each([
      ['tops up a remainder below the rent floor', 400_000, 490_880],
      ['leaves a zero remainder alone', 0, 0],
      ['leaves a remainder above the floor alone', FLOOR + 1, 0],
    ])('platform transfer %s', async (_name, remainder, topUp) => {
      await round(100_000n);
      fund(100_000 + COST + remainder);
      await __test.payRound(rpc.asConnection(), launch);
      const first = transfers()[0];
      if (topUp) expect(first.lamports).toBe(topUp);
      else expect(first.to).toBe(treasury.publicKey.toBase58());
      expect((await launchRow()).rentReserveLamports).toBe(BigInt(topUp));
    });
    it('pauses when the balance cannot cover the debit', async () => {
      await round(100_000n);
      fund(50_000);
      await expect(__test.payRound(rpc.asConnection(), launch)).rejects.toBeInstanceOf(
        FinancePauseError,
      );
    });
  });

  describe('failed network cost reimbursement', () => {
    it('absorbs failed cost from the platform share', async () => {
      const r = await round(100_000n);
      await db.feeClaim.createMany({
        data: [
          {
            launchId: launch.id,
            roundId: r.id,
            signature: 'c1',
            source: 'bonding-curve-and-amm',
            grossLamports: 5_000_000n,
            costLamports: 10_000n,
          },
          {
            launchId: launch.id,
            roundId: r.id,
            signature: 'f1',
            source: 'failed-network-cost',
            grossLamports: 0n,
            costLamports: 5_000n,
          },
        ],
      });
      fund(5_000_000);
      await __test.payRound(rpc.asConnection(), launch);
      expect(decodeTransfers(rpc.sent[0]).transfers).toEqual([
        { from: fee.publicKey.toBase58(), to: treasury.publicKey.toBase58(), lamports: 95_000 },
        { from: fee.publicKey.toBase58(), to: operator.publicKey.toBase58(), lamports: 25_000 },
      ]);
      expect((await db.rewardRound.findUniqueOrThrow({ where: { id: r.id } })).costLamports).toBe(
        5_000n,
      );
    });
    it('omits the treasury transfer when failed cost exceeds the platform share', async () => {
      const r = await round(100_000n);
      await db.feeClaim.create({
        data: {
          launchId: launch.id,
          roundId: r.id,
          signature: 'f2',
          source: 'failed-network-cost',
          grossLamports: 0n,
          costLamports: 200_000n,
        },
      });
      fund(5_000_000);
      await __test.payRound(rpc.asConnection(), launch);
      expect(decodeTransfers(rpc.sent[0]).transfers).toEqual([
        {
          from: fee.publicKey.toBase58(),
          to: operator.publicKey.toBase58(),
          lamports: 100_000 + COST,
        },
      ]);
      expect((await launchRow()).error).toMatch(/absorbed 100000 lamports/);
    });
  });

  describe('single flight signing', () => {
    it('lets only one of two concurrent payouts record and broadcast', async () => {
      const r = await round();
      await payout(r.id, 2_000_000n);
      fund(10_000_000);
      const results = await Promise.allSettled([
        __test.payRound(rpc.asConnection(), launch),
        __test.payRound(rpc.asConnection(), launch),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(
        String((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason),
      ).toMatch(/pending|Unique|Payout rows/);
      expect(await db.financialTx.count({ where: { launchId: launch.id } })).toBe(1);
      expect(rpc.sent).toHaveLength(1);
    });
    it('derives the key from a sequence so a retry after expiry gets the next one', async () => {
      const r = await round();
      const wallet = Keypair.generate().publicKey.toBase58();
      await payout(r.id, 2_000_000n, wallet);
      fund(10_000_000);
      await __test.payRound(rpc.asConnection(), launch);
      const first = await db.financialTx.findFirstOrThrow({ where: { launchId: launch.id } });
      expect(first.key).toBe(`payout:${r.id}:${wallet}:0`);
      await db.financialTx.update({
        where: { id: first.id },
        data: { createdAt: new Date(Date.now() - 600000) },
      });
      rpc.blockHeight = rpc.lastValidBlockHeight + 200;
      await __test.reconcileFinancial(rpc.asConnection(), launch);
      rpc.blockhash = Keypair.generate().publicKey.toBase58();
      await __test.payRound(rpc.asConnection(), launch);
      const keys = (await db.financialTx.findMany({ orderBy: { createdAt: 'asc' } })).map(
        (t) => t.key,
      );
      expect(keys).toEqual([`payout:${r.id}:${wallet}:0`, `payout:${r.id}:${wallet}:1`]);
    });
  });

  describe('claiming fees', () => {
    const curveVault = () => creatorVaultPda(fee.publicKey).toBase58();
    const nativeVault = () =>
      getAssociatedTokenAddressSync(
        NATIVE_MINT,
        ammCreatorVaultPda(fee.publicKey),
        true,
      ).toBase58();
    const destination = () => getAssociatedTokenAddressSync(NATIVE_MINT, fee.publicKey, true);
    const dummy = () =>
      new TransactionInstruction({
        programId: Keypair.generate().publicKey,
        keys: [],
        data: Buffer.alloc(1),
      });
    const arrange = (amm: number) => {
      rpc.accounts.set(curveVault(), { data: Buffer.alloc(0), lamports: 890_880 + 2_000_000 });
      if (amm) {
        rpc.accounts.set(nativeVault(), { data: Buffer.alloc(165) });
        rpc.tokenBalances.set(nativeVault(), String(amm));
      }
      mocks.collect.mockResolvedValue([dummy(), dummy()]);
    };
    const tokenAccount = (overrides: { closeAuthority?: PublicKey; owner?: PublicKey } = {}) => {
      const data = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode(
        {
          mint: NATIVE_MINT,
          owner: overrides.owner ?? fee.publicKey,
          amount: 0n,
          delegateOption: 0,
          delegate: PublicKey.default,
          state: 1,
          isNativeOption: 1,
          isNative: 2_039_280n,
          delegatedAmount: 0n,
          closeAuthorityOption: overrides.closeAuthority ? 1 : 0,
          closeAuthority: overrides.closeAuthority ?? PublicKey.default,
        },
        data,
      );
      return { data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280 };
    };
    const programs = () => Transaction.from(rpc.sent[0]).instructions;
    const isClose = (ix: TransactionInstruction) =>
      ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9;
    const isCreate = (ix: TransactionInstruction) =>
      ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID);
    const isRent = (ix: TransactionInstruction) => ix.programId.equals(SystemProgram.programId);
    it('creates, closes and reimburses the wSOL account when none exists', async () => {
      arrange(3_000_000);
      expect(await __test.claimFees(rpc.asConnection(), launch)).toBe(true);
      const ixs = programs();
      expect(ixs.some(isCreate)).toBe(true);
      expect(ixs.some(isClose)).toBe(true);
      expect(ixs.some(isRent)).toBe(true);
    });
    it('uses a wSOL account someone else created without paying rent for it', async () => {
      arrange(3_000_000);
      rpc.accounts.set(destination().toBase58(), tokenAccount());
      expect(await __test.claimFees(rpc.asConnection(), launch)).toBe(true);
      const ixs = programs();
      expect(ixs.some(isCreate)).toBe(false);
      expect(ixs.some(isRent)).toBe(false);
      expect(ixs.some(isClose)).toBe(true);
    });
    it('pauses when the wSOL account has a foreign close authority or owner', async () => {
      arrange(3_000_000);
      rpc.accounts.set(
        destination().toBase58(),
        tokenAccount({ closeAuthority: Keypair.generate().publicKey }),
      );
      await expect(__test.claimFees(rpc.asConnection(), launch)).rejects.toBeInstanceOf(
        FinancePauseError,
      );
      rpc.accounts.set(
        destination().toBase58(),
        tokenAccount({ owner: Keypair.generate().publicKey }),
      );
      await expect(__test.claimFees(rpc.asConnection(), launch)).rejects.toBeInstanceOf(
        FinancePauseError,
      );
    });
    it('sweeps a stray wSOL account on a curve-only claim', async () => {
      arrange(0);
      rpc.accounts.set(destination().toBase58(), tokenAccount());
      expect(await __test.claimFees(rpc.asConnection(), launch)).toBe(true);
      expect(programs().some(isClose)).toBe(true);
    });
  });

  describe('legacy hourly rounds', () => {
    const hour = 3600000;
    const base = Math.floor((Date.now() - 4 * hour) / hour) * hour;
    const setup = async (endsAt: number, claims: [string, number][]) => {
      const raid = await db.raid.create({
        data: {
          tag: `raid_legacy_${Math.random().toString(36).slice(2, 8)}`,
          title: 'Legacy',
          description: '',
          creatorId: userId,
          status: 'ENDED',
          trackingVersion: 1,
          tokenLaunchId: launch.id,
          startsAt: new Date(base),
          endsAt: new Date(endsAt),
          coverage: 'complete',
          coveredUntil: new Date(base + 4 * hour),
        },
      });
      await db.rewardEnrollment.create({
        data: {
          launchId: launch.id,
          userId,
          xId: 'raider',
          walletAddress: Keypair.generate().publicKey.toBase58(),
          joinedAt: new Date(base - 1000),
        },
      });
      const windows = Math.ceil((endsAt - base) / hour);
      for (let i = 0; i < windows; i++)
        await db.post.create({
          data: {
            id: `legacy-${raid.id}-${i}`,
            raidId: raid.id,
            authorId: 'raider',
            text: `post number ${i} for this window`,
            normalized: `post number ${i} for this window`,
            createdAt: new Date(base + i * hour + 600000),
            observedAt: new Date(),
          },
        });
      for (const [signature, at] of claims)
        await db.feeClaim.create({
          data: {
            launchId: launch.id,
            signature,
            source: 'bonding-curve-and-amm',
            grossLamports: 50_000_000n,
            costLamports: 5_000n,
            claimedAt: new Date(at),
          },
        });
      return raid;
    };
    it('consumes only claims made before the window closed', async () => {
      await setup(base + 2 * hour, [
        ['early', base + 30 * 60000],
        ['late', base + hour + 30 * 60000],
      ]);
      expect(await settleNextRound(rpc.asConnection(), launch)).toBe(true);
      let rounds = await db.rewardRound.findMany({ orderBy: { startsAt: 'asc' } });
      expect(rounds).toHaveLength(1);
      expect(rounds[0].grossLamports).toBe(50_000_000n);
      expect(await settleNextRound(rpc.asConnection(), launch)).toBe(true);
      rounds = await db.rewardRound.findMany({ orderBy: { startsAt: 'asc' } });
      expect(rounds).toHaveLength(2);
      expect(rounds[1].grossLamports).toBe(50_000_000n);
      expect(+rounds[1].startsAt).toBe(base + hour);
    });
    it('skips an empty window instead of stalling', async () => {
      await setup(base + 2 * hour, [['only', base + hour + 30 * 60000]]);
      expect(await settleNextRound(rpc.asConnection(), launch)).toBe(true);
      const rounds = await db.rewardRound.findMany();
      expect(rounds).toHaveLength(1);
      expect(+rounds[0].startsAt).toBe(base + hour);
    });
    it('lets the final window sweep claims made after the raid ended', async () => {
      await setup(base + 2 * hour, [['after', base + 2 * hour + 30 * 60000]]);
      expect(await settleNextRound(rpc.asConnection(), launch)).toBe(true);
      const rounds = await db.rewardRound.findMany();
      expect(rounds).toHaveLength(1);
      expect(+rounds[0].startsAt).toBe(base + hour);
    });
  });
});
