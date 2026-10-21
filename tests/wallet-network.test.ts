import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const host = vi.hoisted(() => {
  const tx = {
    walletChallenge: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    walletLink: { findUnique: vi.fn() },
    walletIdentity: { findUnique: vi.fn(), create: vi.fn() },
    user: { findUniqueOrThrow: vi.fn() },
    xAccount: { findUnique: vi.fn() },
    session: { create: vi.fn() },
  };
  return { tx, lookup: vi.fn(), link: vi.fn() };
});
vi.mock('../src/lib/db', () => ({
  db: { ...host.tx, $transaction: async (run: (tx: typeof host.tx) => unknown) => run(host.tx) },
}));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (
    _db: unknown,
    run: (port: unknown, tx: typeof host.tx) => unknown,
  ) => run({}, host.tx),
}));
vi.mock('../src/lib/identity-protocol', () => ({
  prepareIdentity: async () => ({}),
  identityWriter: () => host.tx,
  identityClock: async () => new Date(),
}));
vi.mock('../src/identity-link', async (original) => ({
  ...(await original<typeof import('../src/identity-link')>()),
  lookupWalletLink: host.lookup,
  linkVerifiedWallet: host.link,
  publicWalletLink: (value: unknown) => value,
}));
import {
  createWalletChallenge,
  linkAdditionalWallet,
  verifyWalletChallenge,
} from '../src/lib/wallet-auth';

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(77));
const address = wallet.publicKey.toBase58();
const sign = (message: string) =>
  bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), wallet.secretKey));
async function stored(network: string) {
  vi.stubEnv('USDC_NETWORK', network);
  const challenge = await createWalletChallenge(address);
  const row = { ...host.tx.walletChallenge.create.mock.calls.at(-1)![0].data, consumedAt: null };
  host.tx.walletChallenge.findUnique.mockResolvedValue(row);
  return { challenge, row };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('USDC_NETWORK', 'mainnet');
  host.lookup.mockResolvedValue(null);
  host.tx.walletLink.findUnique.mockImplementation(() => host.lookup());
  Object.assign(host.tx.walletChallenge, { findUniqueOrThrow: host.tx.walletChallenge.findUnique });
  host.tx.walletChallenge.updateMany.mockResolvedValue({ count: 1 });
  host.tx.walletIdentity.findUnique.mockResolvedValue({ userId: 'owner' });
  host.tx.user.findUniqueOrThrow.mockResolvedValue({ id: 'owner', suspended: false });
  host.tx.xAccount.findUnique.mockResolvedValue({ userId: 'owner' });
  host.link.mockResolvedValue({ linkId: 'link' });
});
afterEach(() => vi.unstubAllEnvs());

describe('configured SIWS network and stored challenge compatibility (T007 partial)', () => {
  it.each(['devnet', 'mainnet'])('issues and verifies an exact %s challenge', async (network) => {
    const { challenge } = await stored(network);
    expect(challenge.message).toContain(`\nChain ID: ${network}\n`);
    await verifyWalletChallenge(challenge.digest, sign(challenge.message), address);
    expect(host.tx.session.create).toHaveBeenCalledOnce();
  });
  it('rejects a registered credential on a different chain before creating a session', async () => {
    const { challenge } = await stored('devnet');
    host.lookup.mockResolvedValue({
      accountId: 'owner',
      status: 'ACTIVE',
      networkIdentity: 'mainnet',
      accountSuspended: false,
    });
    await expect(
      verifyWalletChallenge(challenge.digest, sign(challenge.message), address),
    ).rejects.toMatchObject({ status: 401 });
    expect(host.tx.session.create).not.toHaveBeenCalled();
  });
  it('preserves a pending mainnet challenge across a configuration change to devnet', async () => {
    const { challenge } = await stored('mainnet');
    vi.stubEnv('USDC_NETWORK', 'devnet');
    host.lookup.mockResolvedValue({
      accountId: 'owner',
      status: 'ACTIVE',
      networkIdentity: 'mainnet',
      accountSuspended: false,
    });
    await verifyWalletChallenge(challenge.digest, sign(challenge.message), address);
    expect(host.tx.session.create).toHaveBeenCalledOnce();
    expect(host.tx.walletIdentity.create).not.toHaveBeenCalled();
  });
  it('rejects altered stored chain text even when signed again, retaining the issued digest', async () => {
    const { challenge, row } = await stored('mainnet');
    const message = row.message.replace('Chain ID: mainnet', 'Chain ID: devnet');
    host.tx.walletChallenge.findUnique.mockResolvedValue({ ...row, message });
    await expect(
      verifyWalletChallenge(challenge.digest, sign(message), address),
    ).rejects.toMatchObject({ status: 401 });
    expect(host.tx.walletChallenge.updateMany).not.toHaveBeenCalled();
    expect(host.tx.session.create).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'testnet', 'sandbox', 'MAINNET'])(
    'fails closed for production network %j before issue or consumption',
    async (network) => {
      const { challenge } = await stored('mainnet');
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('USDC_NETWORK', network);
      host.tx.walletChallenge.create.mockClear();
      await expect(createWalletChallenge(address)).rejects.toMatchObject({ status: 503 });
      await expect(
        verifyWalletChallenge(challenge.digest, sign(challenge.message), address),
      ).rejects.toMatchObject({ status: 503 });
      expect(host.tx.walletChallenge.create).not.toHaveBeenCalled();
      expect(host.tx.walletChallenge.updateMany).not.toHaveBeenCalled();
    },
  );
  it('retains the nonproduction mainnet default when network is unset', async () => {
    vi.stubEnv('USDC_NETWORK', undefined);
    expect((await createWalletChallenge(address)).message).toContain('\nChain ID: mainnet\n');
  });
  it('passes the signed devnet network consistently to additional-link subject/proof/policy', async () => {
    vi.stubEnv('USDC_NETWORK', 'devnet');
    vi.stubEnv('WALLET_LINKS_ENABLED', 'true');
    const challenge = await createWalletChallenge(address, 'owner', 'link-additional');
    host.tx.walletChallenge.findUnique.mockResolvedValue({
      ...host.tx.walletChallenge.create.mock.calls.at(-1)![0].data,
      consumedAt: null,
    });
    await linkAdditionalWallet(
      'owner',
      challenge.digest,
      sign(challenge.message),
      address,
      'own-session',
      'request',
    );
    const input = host.link.mock.calls[0][1];
    expect(input.subject).toEqual({ networkIdentity: 'devnet', address });
    expect(input.proof.subject).toEqual({ kind: 'WALLET', networkIdentity: 'devnet', address });
    expect(input.policy.walletNetworks).toEqual(['devnet']);
  });
});
