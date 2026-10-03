import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { UsdcTransfer } from '@prisma/client';
const chain = vi.hoisted(() => ({ paid: null as string | null }));
vi.mock('../src/lib/usdc-chain', () => ({ findTransferPayment: vi.fn(async () => chain.paid) }));
const rpc = vi.hoisted(() => ({ custody: 0n, receiptFor: null as unknown }));
vi.mock('@solana/web3.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@solana/web3.js')>()),
  Connection: class {
    getGenesisHash = async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    getParsedTransaction = async () => receiptFor(rpc.receiptFor as UsdcTransfer);
    getTokenAccountBalance = async () => ({ value: { amount: rpc.custody.toString() } });
  },
}));
const market = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../src/lib/providers/market', () => ({ fetchMarket: vi.fn(async () => market.value) }));
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { createRaid } from '../src/lib/campaigns';
import { saveStudioRaid, launchStudioRaid } from '../src/lib/studio-campaigns';
import {
  balance,
  requestWithdrawal,
  rejectWithdrawal,
  verifyUsdcTransfer,
  USDC_MINTS,
} from '../src/lib/usdc';
import { allocateUsdcRaid, releaseFundedRaid } from '../src/lib/studio-finance';
import { allocateRaidFunding } from '../src/lib/raid-allocation';
import { reconcileUsdc } from '../src/lib/usdc-reconcile';
import { enqueue, claimJob } from '../src/lib/queue';
import { runJob } from '../src/lib/worker-jobs';
import { displayIdentity } from '../src/lib/token-identity';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';
vi.mock('../src/lib/providers/x', () => ({
  lookupPosts: vi.fn(async (ids: string[]) => ({
    data: ids.map((id) => ({ id, text: 'Public target', author_id: 'project' })),
  })),
}));
const sourceOwner = Keypair.generate().publicKey,
  platform = Keypair.generate().publicKey,
  signature = '3'.repeat(88);
function receiptFor(intent: UsdcTransfer): ParsedTransactionWithMeta {
  const mint = new PublicKey(intent.mint),
    source = getAssociatedTokenAddressSync(mint, sourceOwner),
    destination = getAssociatedTokenAddressSync(mint, platform);
  return {
    blockTime: Math.floor(Date.now() / 1000),
    slot: 1,
    transaction: {
      signatures: [],
      message: {
        accountKeys: [
          { pubkey: sourceOwner, signer: true, writable: true },
          { pubkey: destination, signer: false, writable: true },
        ],
        instructions: [
          {
            program: 'spl-memo',
            programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
            parsed: `useRAID:usdc:${intent.id}`,
          },
          {
            program: 'spl-token',
            programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            parsed: {
              type: 'transferChecked',
              info: {
                authority: sourceOwner.toBase58(),
                source: source.toBase58(),
                destination: destination.toBase58(),
                mint: intent.mint,
                tokenAmount: { amount: intent.amount.toString(), decimals: 6 },
              },
            },
          },
        ],
        recentBlockhash: '',
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: intent.mint,
          uiTokenAmount: { amount: intent.amount.toString(), decimals: 6, uiAmount: 1 },
        },
      ],
    },
  };
}
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

suite('USDC operations', () => {
  let owner: Awaited<ReturnType<typeof db.user.create>>,
    admin: Awaited<ReturnType<typeof db.user.create>>;
  const draft = (user = owner, extra: Record<string, unknown> = {}) =>
    saveStudioRaid(user, {
      studioVersion: 1,
      projectType: 'PROJECT',
      title: 'Ops raid',
      targetPosts: ['https://x.com/project/status/123456789'],
      impressionTarget: 2000,
      duration: 24,
      ...extra,
    }).then((raid) => raid.id);
  const credit = (userId: string, key: string, amount: bigint) =>
    db.balanceEntry.create({
      data: { userId, key, kind: 'DEPOSIT', availableDelta: amount, reservedDelta: 0n },
    });
  const deposit = (amount: bigint, expiresAt: Date) =>
    db.usdcTransfer.create({
      data: {
        userId: owner.id,
        kind: 'DEPOSIT',
        amount,
        status: 'AWAITING_TRANSFER',
        walletAddress: sourceOwner.toBase58(),
        recipient: platform.toBase58(),
        mint: USDC_MINTS.mainnet,
        network: 'mainnet',
        expiresAt,
      },
    });
  const launched = async () => {
    const id = await draft();
    await launchStudioRaid(owner, id, '2000000', true);
    return id;
  };
  beforeAll(async () => {
    assertTestDatabase();
    await truncateAll(db);
    vi.stubEnv('USDC_MICROS_PER_1000_IMPRESSIONS', '1000000');
    vi.stubEnv('USDC_FUNDING_ADDRESS', Keypair.generate().publicKey.toBase58());
    vi.stubEnv('SOLANA_RPC_URL', 'https://example.invalid');
    vi.stubEnv('X_BEARER_TOKEN', 'fixture');
    vi.stubEnv('X_TRACKING_V2_SETTLEMENT_ENABLED', 'true');
    vi.stubEnv('RAID_LAMPORTS_PER_1000_IMPRESSIONS', '1000000000');
    vi.stubEnv('RAID_FUNDING_ADDRESS', Keypair.generate().publicKey.toBase58());
    vi.stubEnv('X_ADMIN_USER_ID', 'ops-admin');
    config.demo = false;
    config.liveApproved = true;
    await db.settings.create({ data: { collectionEnabled: true } });
    owner = await db.user.create({
      data: { xId: 'ops-owner', handle: 'opsowner', approved: true },
    });
    admin = await db.user.create({ data: { xId: 'ops-admin', handle: 'opsadmin', role: 'ADMIN' } });
    await db.xAccount.create({
      data: { userId: owner.id, xUserId: owner.xId!, username: owner.handle, displayName: 'Ops' },
    });
    await db.walletIdentity.create({
      data: { userId: owner.id, address: Keypair.generate().publicKey.toBase58() },
    });
    await credit(owner.id, 'ops-credit', 100_000_000n);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$disconnect();
  });

  it('releases a hidden raid pool once and blocks settlement afterwards', async () => {
    const id = await launched();
    const before = await balance(owner.id);
    await expect(releaseFundedRaid(id, admin.id, 'visible raid')).rejects.toMatchObject({
      status: 409,
    });
    await db.raid.update({ where: { id }, data: { hidden: true } });
    await expect(releaseFundedRaid(id, owner.id, 'not an admin')).rejects.toMatchObject({
      status: 403,
    });
    await expect(releaseFundedRaid(id, admin.id, 'no')).rejects.toMatchObject({ status: 400 });
    await releaseFundedRaid(id, admin.id, 'Creator suspended pending review');
    expect(await balance(owner.id)).toEqual({
      available: before.available + 2_000_000n,
      reserved: before.reserved - 2_000_000n,
    });
    const raid = await db.raid.findUniqueOrThrow({ where: { id } });
    expect(raid).toMatchObject({
      status: 'ENDED',
      trackingPhase: 'HELD_RESOLVED',
      holdReason: 'RELEASED_BY_ADMIN',
    });
    await expect(releaseFundedRaid(id, admin.id, 'Second attempt')).rejects.toMatchObject({
      status: 409,
    });
    await db.raid.update({ where: { id }, data: { hidden: false, trackingPhase: 'APPROVED' } });
    await allocateUsdcRaid(id);
    expect(await db.balanceEntry.count({ where: { raidId: id, kind: 'RAID_SETTLED' } })).toBe(0);
    expect(await db.balanceEntry.count({ where: { raidId: id, kind: 'RAID_RELEASED' } })).toBe(1);
    expect(
      await db.moderationEvent.count({ where: { action: 'funded-raid-released', targetId: id } }),
    ).toBe(1);
  });

  it('refuses release once settled, and settlement cannot follow a release key', async () => {
    const id = await launched();
    await db.raid.update({ where: { id }, data: { hidden: true, trackingPhase: 'ALLOCATED' } });
    await expect(releaseFundedRaid(id, admin.id, 'Already allocated')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('releases a funded SOL raid with exactly one refund row', async () => {
    const raid = await createRaid(owner, {
      projectType: 'PROJECT',
      title: 'Sol release',
      description: 'A funded campaign for independent projects.',
      symbol: 'SOL',
      name: 'Sol Project',
      fundingRequest: 'Fund qualifying raider impressions in SOL.',
      fundingTermsAccepted: true,
      impressionTarget: 2000,
    });
    const wallet = Keypair.generate().publicKey.toBase58();
    await db.raid.update({
      where: { id: raid.id },
      data: { fundingStatus: 'VERIFIED', fundingWallet: wallet, status: 'ACTIVE', hidden: true },
    });
    await releaseFundedRaid(raid.id, admin.id, 'Hidden for abuse review');
    const rows = await db.raidAllocation.findMany({ where: { raidId: raid.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'REFUND',
      walletAddress: wallet,
      lamports: raid.fundingLamports,
      resultId: null,
    });
    await db.raid.update({ where: { id: raid.id }, data: { hidden: false } });
    await allocateRaidFunding(raid.id);
    expect(await db.raidAllocation.count({ where: { raidId: raid.id } })).toBe(1);
    await expect(releaseFundedRaid(raid.id, admin.id, 'Again please')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('credits an expired deposit only through the audited admin override', async () => {
    const intent = await deposit(5_000_000n, new Date(Date.now() - 3600000));
    rpc.receiptFor = intent;
    await expect(verifyUsdcTransfer(intent.id, signature, admin.id, true)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      verifyUsdcTransfer(intent.id, signature, owner.id, false, { reason: 'user attempt' }),
    ).rejects.toMatchObject({ status: 403 });
    const before = (await balance(owner.id)).available;
    await verifyUsdcTransfer(intent.id, signature, admin.id, true, {
      reason: 'Customer proved the transfer',
    });
    expect((await balance(owner.id)).available).toBe(before + 5_000_000n);
    expect(
      await db.moderationEvent.count({
        where: { action: 'usdc-late-deposit', targetId: intent.id },
      }),
    ).toBe(1);
  });

  it('answers a replayed signature with 409 instead of a unique-index failure', async () => {
    const other = await deposit(1_000_000n, new Date(Date.now() + 3600000));
    rpc.receiptFor = other;
    const before = (await balance(owner.id)).available;
    await expect(verifyUsdcTransfer(other.id, signature, admin.id, true)).rejects.toMatchObject({
      status: 409,
      message: 'This transaction already settled another transfer.',
    });
    expect((await balance(owner.id)).available).toBe(before);
    expect((await db.usdcTransfer.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      'AWAITING_TRANSFER',
    );
  });

  it('refuses to reject a withdrawal already paid on-chain', async () => {
    const withdrawal = await requestWithdrawal(owner.id, 2_000_000n, 'ops-withdrawal-000001');
    chain.paid = 'paid-signature';
    await expect(
      rejectWithdrawal(withdrawal.id, admin.id, 'Operator rejection'),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect((await db.usdcTransfer.findUniqueOrThrow({ where: { id: withdrawal.id } })).status).toBe(
      'REQUESTED',
    );
    expect(await db.balanceEntry.count({ where: { kind: 'WITHDRAWAL_RELEASED' } })).toBe(0);
    chain.paid = null;
    await rejectWithdrawal(withdrawal.id, admin.id, 'Operator rejection');
    expect(await db.balanceEntry.count({ where: { kind: 'WITHDRAWAL_RELEASED' } })).toBe(1);
  });

  it('holds withdrawals for 24 hours after a wallet change', async () => {
    await db.walletIdentity.update({
      where: { userId: owner.id },
      data: { rotatedAt: new Date(Date.now() - 3600000) },
    });
    await expect(
      requestWithdrawal(owner.id, 1_000_000n, 'ops-withdrawal-hold-1'),
    ).rejects.toMatchObject({ status: 409 });
    await db.walletIdentity.update({
      where: { userId: owner.id },
      data: { rotatedAt: new Date(Date.now() - 25 * 3600000) },
    });
    await expect(
      requestWithdrawal(owner.id, 999_999_000_000n, 'ops-withdrawal-hold-2'),
    ).rejects.toMatchObject({ message: 'Insufficient available USDC.' });
    await db.walletIdentity.update({ where: { userId: owner.id }, data: { rotatedAt: null } });
  });

  it('reconciles ledger liabilities and pending rewards against custody', async () => {
    await db.usdcTransfer.create({
      data: {
        userId: owner.id,
        kind: 'REWARD',
        amount: 700_000n,
        walletAddress: 'w',
        recipient: 'r',
        mint: 'm',
        network: 'mainnet',
      },
    });
    const ledger = await db.balanceEntry.aggregate({
      where: { network: 'mainnet' },
      _sum: { availableDelta: true, reservedDelta: true },
    });
    const liabilities = ledger._sum.availableDelta! + ledger._sum.reservedDelta!;
    rpc.custody = liabilities + 700_000n + 5n;
    const ok = await reconcileUsdc('mainnet');
    expect(ok).toMatchObject({ liabilities, pendingRewards: 700_000n, surplus: 5n });
    rpc.custody = liabilities;
    expect((await reconcileUsdc('mainnet')).surplus).toBe(-700_000n);
    expect((await reconcileUsdc('sandbox')).custody).toBeNull();
  });

  it('keeps creator-supplied token metadata per raid until the market provider verifies it', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const rival = await db.user.create({
      data: { xId: 'ops-rival', handle: 'opsrival', approved: true },
    });
    await db.xAccount.create({
      data: { userId: rival.id, xUserId: rival.xId!, username: rival.handle, displayName: 'R' },
    });
    const token = (user: typeof owner, name: string, symbol: string) =>
      draft(user, {
        projectType: 'TOKEN',
        mint,
        name,
        symbol,
        imageUri: 'https://pbs.twimg.com/i.png',
      });
    const a = await db.raid.findUniqueOrThrow({
      where: { id: await token(owner, 'Alpha', 'AAA') },
      include: { token: true },
    });
    expect(a).toMatchObject({ projectName: 'Alpha', projectSymbol: 'AAA' });
    const b = await db.raid.findUniqueOrThrow({
      where: { id: await token(rival, 'Beta', 'BBB') },
      include: { token: true },
    });
    expect(b).toMatchObject({ projectName: 'Beta', projectSymbol: 'BBB' });
    expect(b.token).toMatchObject({ name: 'Alpha', metadataSource: 'CREATOR', imageUri: null });
    expect(displayIdentity(b)).toMatchObject({ name: 'Beta', symbol: 'BBB' });

    market.value = {
      name: 'Real Token',
      symbol: 'REAL',
      imageUri: 'https://dex.test/real.png',
      price: 1,
    };
    await enqueue('market', `market:${mint}`, { mint });
    await runJob((await claimJob())!);
    const verified = await db.token.findUniqueOrThrow({ where: { mint } });
    expect(verified).toMatchObject({
      name: 'Real Token',
      symbol: 'REAL',
      imageUri: 'https://dex.test/real.png',
      metadataSource: 'MARKET',
    });
    expect(verified.metadataVerifiedAt).not.toBeNull();
    const c = await db.raid.findUniqueOrThrow({
      where: { id: await token(rival, 'Gamma', 'GGG') },
      include: { token: true },
    });
    expect(c).toMatchObject({ projectName: 'Real Token', projectSymbol: 'REAL' });
    expect(displayIdentity(a)).toMatchObject({ name: 'Alpha' });
    expect(displayIdentity({ ...a, token: verified })).toMatchObject({
      name: 'Real Token',
      symbol: 'REAL',
    });
  });
});
