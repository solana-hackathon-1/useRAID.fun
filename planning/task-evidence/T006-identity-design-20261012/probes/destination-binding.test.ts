// Owner-contract RED retained for the post-design T007 implementation; no production fix yet.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createWalletChallenge } from '../../../../src/lib/wallet-auth';
import { db } from '../../../../src/lib/db';
import { Keypair } from '@solana/web3.js';
import { assertTestDatabase, truncateAll } from '../../../../tests/helpers/db-guard';

const observer = new PrismaClient();
describe('accepted visible destination binding, DEC-2026-10-12-04', () => {
  beforeEach(async () => {
    assertTestDatabase();
    await truncateAll(db);
    vi.stubEnv('WALLET_LINKS_ENABLED', 'true');
    vi.stubEnv('USDC_NETWORK', 'devnet');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([db.$disconnect(), observer.$disconnect()]);
  });

  it('shows the stable destination account and connected X handle in the actual signed bytes', async () => {
    const user = await db.user.create({
      data: { handle: 'synthetic_destination', xId: 'synthetic-x' },
    });
    await db.xAccount.create({
      data: {
        userId: user.id,
        xUserId: user.xId!,
        username: user.handle,
        displayName: 'Synthetic',
      },
    });
    const challenge = await createWalletChallenge(
      Keypair.generate().publicKey.toBase58(),
      user.id,
      'link-additional',
    );
    const stored = await observer.walletChallenge.findUniqueOrThrow({
      where: { digest: challenge.digest },
    });
    expect(stored.userId).toBe(user.id);
    expect(stored.message).toBe(challenge.message);
    // These checks constrain visible consent, without prescribing the still-unreviewed serialization.
    expect.soft(challenge.message).toContain(user.id);
    expect.soft(challenge.message).toContain(`@${user.handle}`);
  });
});
