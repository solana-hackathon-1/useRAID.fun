import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { FakeRpc } from './helpers/fake-solana';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
import { routeContext, routeRequest } from './helpers/route';

const mocks = vi.hoisted(() => ({
  rpc: null as unknown,
  curve: vi.fn(),
  user: vi.fn(),
}));
vi.mock('../src/lib/release', () => ({
  launchpadsAvailable: true,
  assertLaunchpadsAvailable: () => {},
}));
vi.mock('@solana/web3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/web3.js')>()),
  Connection: class {
    constructor() {
      return mocks.rpc as object;
    }
  },
}));
vi.mock('../src/lib/pump-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/pump-sdk')>();
  return {
    ...original,
    PUMP_SDK: new Proxy(original.PUMP_SDK, {
      get: (target, key) =>
        key === 'decodeBondingCurve'
          ? mocks.curve
          : (() => {
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            })(),
    }),
  };
});
vi.mock('../src/lib/launch-ipfs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/launch-ipfs')>()),
  verifyAsset: () => {},
  pinMetadata: async () => 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyvu',
}));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  checkOrigin: vi.fn(),
  requireUser: mocks.user,
}));
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { PUMP_PROGRAM_ID, bondingCurvePda } from '../src/lib/pump-sdk';
import { prepareLaunch, reconcileLaunch } from '../src/lib/pump-launch';
import { encryptSecret, generateSealKeyPair, sealSecret } from '../src/lib/launch-crypto';
import { rotateLaunchKeys } from '../src/lib/launch-rotation';
import { POST as enroll } from '../src/app/api/launch/[id]/enroll/route';
import { POST as admin } from '../src/app/api/admin/[action]/route';

const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const operator = Keypair.generate();
const treasury = Keypair.generate();
const names = [
  'LAUNCH_ENABLED',
  'PAYOUT_ENABLED',
  'X_BEARER_TOKEN',
  'SOLANA_RPC_URL',
  'PINATA_JWT',
  'LAUNCH_KEY_VERSION',
  'LAUNCH_KEY_1',
  'LAUNCH_KEY_2',
  'FEE_SEAL_PUBLIC_1',
  'FEE_SEAL_PRIVATE_1',
  'LAUNCH_ASSET_KEY',
  'OPERATOR_PUBLIC_KEY',
  'PLATFORM_TREASURY_ADDRESS',
] as const;
const previousEnv = Object.fromEntries(names.map((n) => [n, process.env[n]]));
const input = {
  name: 'Fixture',
  symbol: 'FIX',
  description: 'A fixture token launch',
  imageUri: 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyvu',
  imageProof: '1.1.proof',
};

suite('launch flow', () => {
  let rpc: FakeRpc;
  let userId: string;
  let wallet: Keypair;
  beforeAll(async () => {
    assertTestDatabase();
    await truncateAll(db);
    config.demo = false;
    config.liveApproved = true;
    Object.assign(process.env, {
      LAUNCH_ENABLED: 'true',
      PAYOUT_ENABLED: 'true',
      X_BEARER_TOKEN: 'token',
      SOLANA_RPC_URL: 'https://rpc.example',
      PINATA_JWT: 'jwt',
      LAUNCH_KEY_1: Buffer.alloc(32, 5).toString('base64'),
      LAUNCH_ASSET_KEY: Buffer.alloc(32, 6).toString('base64'),
      OPERATOR_PUBLIC_KEY: operator.publicKey.toBase58(),
      PLATFORM_TREASURY_ADDRESS: treasury.publicKey.toBase58(),
    });
    delete process.env.LAUNCH_KEY_VERSION;
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
    await db.post.deleteMany();
    await db.rewardEnrollment.deleteMany();
    await db.financialTx.deleteMany();
    await db.moderationEvent.deleteMany();
    await db.raid.deleteMany();
    await db.tokenLaunch.deleteMany();
    await db.token.deleteMany();
    await db.walletIdentity.deleteMany();
    await db.settings.deleteMany();
    await db.user.deleteMany();
    rpc = new FakeRpc();
    mocks.rpc = rpc;
    wallet = Keypair.generate();
    userId = (await createUser('launcher', true)).id;
    await db.walletIdentity.create({ data: { userId, address: wallet.publicKey.toBase58() } });
    await db.settings.create({
      data: {
        id: 'global',
        collectionEnabled: true,
        payoutWorkerAt: new Date(),
        operatorAddress: operator.publicKey.toBase58(),
        maxActiveRaids: 10,
      },
    });
  });
  const createUser = (xId: string, approved: boolean) =>
    db.user.create({ data: { xId, handle: xId, approved } });
  const launchRow = (id: string) => db.tokenLaunch.findUniqueOrThrow({ where: { id } });

  describe('preparing a launch', () => {
    it('requires an approved creator', async () => {
      const stranger = await createUser('stranger', false);
      await expect(prepareLaunch(stranger.id, input)).rejects.toMatchObject({ status: 403 });
      await db.user.update({ where: { id: userId }, data: { suspended: true } });
      await expect(prepareLaunch(userId, input)).rejects.toMatchObject({ status: 403 });
    });
    it('allows one outstanding reservation per user until it expires', async () => {
      const first = await prepareLaunch(userId, input);
      expect('transaction' in first && first.transaction).toBeTruthy();
      await expect(prepareLaunch(userId, input)).rejects.toMatchObject({ status: 409 });
      const row = await launchRow(first.id);
      expect(+row.reservationExpiresAt! - Date.now()).toBeLessThanOrEqual(20 * 60000);
      await db.tokenLaunch.update({
        where: { id: first.id },
        data: { reservationExpiresAt: new Date(Date.now() - 1000) },
      });
      await expect(prepareLaunch(userId, input)).resolves.toMatchObject({
        transaction: expect.any(String),
      });
    });
    it('seals the fee wallet secret so only the worker key opens it', async () => {
      const prepared = await prepareLaunch(userId, input);
      expect((await launchRow(prepared.id)).feeSecret).toMatch(/^s1:/);
    });
  });

  describe('enrolling in a launch raid', () => {
    it('rejects the launch owner on the legacy path', async () => {
      const launch = await db.tokenLaunch.create({
        data: {
          userId,
          mint: Keypair.generate().publicKey.toBase58(),
          name: 'N',
          symbol: 'S',
          description: 'd',
          metadataUri: 'u',
          imageUri: 'i',
          feeAddress: Keypair.generate().publicKey.toBase58(),
          feeSecret: 'x',
          mintSecret: 'y',
          status: 'LIVE',
        },
      });
      const raid = await db.raid.create({
        data: {
          tag: 'raid_legacy_owner',
          title: 'Legacy',
          description: '',
          creatorId: userId,
          tokenLaunchId: launch.id,
          trackingVersion: 1,
          status: 'ACTIVE',
          startsAt: new Date(Date.now() - 1000),
          endsAt: new Date(Date.now() + 3600000),
        },
      });
      await db.tokenLaunch.update({ where: { id: launch.id }, data: { raidId: raid.id } });
      mocks.user.mockResolvedValue({ id: userId });
      const response = await enroll(
        routeRequest('http://localhost/api/launch/x/enroll', { body: {} }),
        routeContext({ id: launch.id }),
      );
      expect(response.status).toBe(403);
      expect(await db.rewardEnrollment.count()).toBe(0);
    });
  });

  describe('admin resume', () => {
    it('refuses while a fresh signed transaction is unresolved', async () => {
      const admin1 = await createUser('admin', true);
      const launch = await db.tokenLaunch.create({
        data: {
          userId,
          mint: Keypair.generate().publicKey.toBase58(),
          name: 'N',
          symbol: 'S',
          description: 'd',
          metadataUri: 'u',
          imageUri: 'i',
          feeAddress: Keypair.generate().publicKey.toBase58(),
          feeSecret: 'x',
          mintSecret: 'y',
          status: 'PAUSED',
        },
      });
      const tx = await db.financialTx.create({
        data: {
          key: 'k1',
          launchId: launch.id,
          kind: 'CLAIM',
          raw: 'r',
          signature: 's1',
          blockhash: 'b',
          lastValidBlockHeight: 1,
        },
      });
      mocks.user.mockResolvedValue({ id: admin1.id });
      const resume = () =>
        admin(
          routeRequest('http://localhost/api/admin/launch-resume', {
            body: { id: launch.id, reason: 'checked chain' },
          }),
          routeContext({ action: 'launch-resume' }),
        );
      expect((await resume()).status).toBe(409);
      expect((await launchRow(launch.id)).status).toBe('PAUSED');
      await db.financialTx.update({
        where: { id: tx.id },
        data: { createdAt: new Date(Date.now() - 11 * 60000) },
      });
      expect((await resume()).status).toBe(200);
      expect((await launchRow(launch.id)).status).toBe('LIVE');
    });
  });

  describe('recovering a launch whose mint is already on chain', () => {
    const creation = (signers: { payer: PublicKey; mintSigns: boolean; mint: PublicKey }) => {
      const message = new TransactionMessage({
        payerKey: signers.payer,
        recentBlockhash: rpc.blockhash,
        instructions: [
          new TransactionInstruction({
            programId: PUMP_PROGRAM_ID,
            keys: [{ pubkey: signers.mint, isSigner: signers.mintSigns, isWritable: true }],
            data: Buffer.from([1]),
          }),
        ],
      }).compileToV0Message();
      return { meta: { err: null, fee: 5000 }, transaction: { message } };
    };
    const seed = async (overrides: Record<string, unknown> = {}) => {
      const mint = Keypair.generate(),
        fee = Keypair.generate();
      const launch = await db.tokenLaunch.create({
        data: {
          userId,
          mint: mint.publicKey.toBase58(),
          name: 'Recovered',
          symbol: 'REC',
          description: 'A recovered launch',
          metadataUri: 'u',
          imageUri: 'i',
          feeAddress: fee.publicKey.toBase58(),
          feeSecret: 'x',
          mintSecret: 'y',
          preparedHash: 'hash-from-an-older-build',
          status: 'PREPARED',
          lastValidBlockHeight: rpc.lastValidBlockHeight,
          ...overrides,
        },
      });
      rpc.accounts.set(mint.publicKey.toBase58(), {
        data: Buffer.alloc(8),
        owner: TOKEN_2022_PROGRAM_ID,
      });
      rpc.accounts.set(bondingCurvePda(mint.publicKey).toBase58(), {
        data: Buffer.alloc(8),
        owner: PUMP_PROGRAM_ID,
      });
      mocks.curve.mockReturnValue({
        creator: fee.publicKey,
        isHolderReward: false,
        isMayhemMode: false,
        quoteMint: PublicKey.default,
      });
      return { launch, mint, fee };
    };
    const land = (mint: Keypair, tx: unknown, signature = 'creation-signature') => {
      rpc.signatures.set(mint.publicKey.toBase58(), [{ signature }]);
      rpc.transactions.set(signature, tx);
      rpc.statuses.set(signature, { confirmationStatus: 'finalized', err: null });
    };
    it('adopts a creation signed by the payer and the mint despite a changed prepared hash', async () => {
      const { launch, mint } = await seed();
      land(mint, creation({ payer: wallet.publicKey, mint: mint.publicKey, mintSigns: true }));
      const result = await reconcileLaunch(launch.id);
      expect(result.status).toBe('LIVE');
      const row = await launchRow(launch.id);
      expect(row).toMatchObject({ status: 'LIVE', signature: 'creation-signature' });
      expect(await db.raid.count({ where: { tokenLaunchId: launch.id } })).toBe(1);
    });
    it('does not adopt a transaction the mint did not sign or another wallet paid for', async () => {
      const { launch, mint } = await seed();
      land(mint, creation({ payer: wallet.publicKey, mint: mint.publicKey, mintSigns: false }));
      await expect(reconcileLaunch(launch.id)).resolves.toMatchObject({ status: 'PREPARED' });
      expect((await launchRow(launch.id)).error).toMatch(/operator review required/);
      land(
        mint,
        creation({ payer: Keypair.generate().publicKey, mint: mint.publicKey, mintSigns: true }),
      );
      await expect(reconcileLaunch(launch.id)).resolves.toMatchObject({ status: 'PREPARED' });
      expect((await launchRow(launch.id)).signature).toBeNull();
    });
    it('does not create a raid when the curve names another creator', async () => {
      const { launch, mint } = await seed();
      land(mint, creation({ payer: wallet.publicKey, mint: mint.publicKey, mintSigns: true }));
      mocks.curve.mockReturnValue({
        creator: Keypair.generate().publicKey,
        isHolderReward: false,
        isMayhemMode: false,
        quoteMint: PublicKey.default,
      });
      await expect(reconcileLaunch(launch.id)).rejects.toThrow(/differs from review/);
      expect(await db.raid.count()).toBe(0);
    });
    it('no longer throws for a submitted launch whose receipt never landed but whose mint exists', async () => {
      const { launch, mint } = await seed({
        status: 'SUBMITTED',
        signature: 'stale-signature',
        signedTx: Buffer.from('raw').toString('base64'),
      });
      rpc.blockHeight = rpc.lastValidBlockHeight + 10;
      await expect(reconcileLaunch(launch.id)).resolves.toMatchObject({ status: 'SUBMITTED' });
      expect((await launchRow(launch.id)).error).toMatch(/operator review required/);
      land(mint, creation({ payer: wallet.publicKey, mint: mint.publicKey, mintSigns: true }));
      await expect(reconcileLaunch(launch.id)).resolves.toMatchObject({ status: 'LIVE' });
      expect((await launchRow(launch.id)).signature).toBe('creation-signature');
    });
  });

  describe('key rotation', () => {
    it('re-seals fee secrets and re-encrypts mint secrets under the active versions', async () => {
      const mint = Keypair.generate(),
        fee = Keypair.generate();
      const legacyFee = encryptSecret(fee.secretKey, `fee:${mint.publicKey}`);
      const legacyMint = encryptSecret(mint.secretKey, `mint:${mint.publicKey}`);
      const launch = await db.tokenLaunch.create({
        data: {
          userId,
          mint: mint.publicKey.toBase58(),
          name: 'N',
          symbol: 'S',
          description: 'd',
          metadataUri: 'u',
          imageUri: 'i',
          feeAddress: fee.publicKey.toBase58(),
          feeSecret: legacyFee,
          mintSecret: legacyMint,
        },
      });
      process.env.LAUNCH_KEY_2 = Buffer.alloc(32, 8).toString('base64');
      process.env.LAUNCH_KEY_VERSION = '2';
      try {
        expect(await rotateLaunchKeys({ apply: false })).toMatchObject({ rotated: 1, failed: 0 });
        expect(await launchRow(launch.id)).toMatchObject({
          feeSecret: legacyFee,
          mintSecret: legacyMint,
        });
        expect(await rotateLaunchKeys({ apply: true })).toMatchObject({ rotated: 1, failed: 0 });
        const row = await launchRow(launch.id);
        expect(row.feeSecret).toMatch(/^s1:/);
        expect(row.mintSecret).toMatch(/^2:/);
        const { decryptFeeSecret, decryptSecret } = await import('../src/lib/launch-crypto');
        expect(
          Keypair.fromSecretKey(
            decryptFeeSecret(row.feeSecret, `fee:${mint.publicKey}`),
          ).publicKey.toBase58(),
        ).toBe(launch.feeAddress);
        expect(
          Keypair.fromSecretKey(
            decryptSecret(row.mintSecret, `mint:${mint.publicKey}`),
          ).publicKey.toBase58(),
        ).toBe(launch.mint);
        expect(await rotateLaunchKeys({ apply: true })).toMatchObject({ rotated: 0, unchanged: 1 });
      } finally {
        delete process.env.LAUNCH_KEY_VERSION;
        delete process.env.LAUNCH_KEY_2;
      }
    });
    it('refuses to rewrite a row whose key does not match its address', async () => {
      const mint = Keypair.generate();
      await db.tokenLaunch.create({
        data: {
          userId,
          mint: mint.publicKey.toBase58(),
          name: 'N',
          symbol: 'S',
          description: 'd',
          metadataUri: 'u',
          imageUri: 'i',
          feeAddress: Keypair.generate().publicKey.toBase58(),
          feeSecret: sealSecret(Keypair.generate().secretKey, `fee:${mint.publicKey}`),
          mintSecret: encryptSecret(mint.secretKey, `mint:${mint.publicKey}`),
        },
      });
      expect(await rotateLaunchKeys({ apply: true })).toMatchObject({ rotated: 0, failed: 1 });
    });
  });
});
