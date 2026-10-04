import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { db } from '../../src/lib/db';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
import { expectCleanPage } from '../helpers/page-checks';

// Meteora pages that render from database rows alone. No RPC, Pinata or operator wallet is configured
// on this server, so trading stays off and chain refresh reports last verified data.
const mint = Keypair.generate().publicKey.toBase58();
let launchId = '';
let ownerToken = '';
test.beforeAll(async () => {
  assertTestDatabase();
  await truncateAll(db);
  const owner = await db.user.create({
    data: { xId: 'meteora-owner-x', handle: 'meteora_owner', approved: true },
  });
  await db.token.create({ data: { mint, name: 'Meteora Fixture', symbol: 'MFX' } });
  launchId = (
    await db.tokenLaunch.create({
      data: {
        userId: owner.id,
        provider: 'METEORA',
        network: 'devnet',
        name: 'Meteora Fixture',
        symbol: 'MFX',
        mint,
        description: 'Fixture launch for page checks.',
        feeAddress: Keypair.generate().publicKey.toBase58(),
        creatorAddress: Keypair.generate().publicKey.toBase58(),
        feeSecret: 'encrypted-fixture',
        mintSecret: 'encrypted-fixture',
        metadataUri: 'ipfs://fixture',
        imageUri: 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyvu',
        status: 'LIVE',
      },
    })
  ).id;
  const token = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      userId: owner.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  ownerToken = token;
});
test.afterAll(async () => {
  await truncateAll(db);
  await db.$disconnect();
});
test('a Meteora token page loads cleanly with trading switched off', async ({ page }, testInfo) => {
  await expectCleanPage(page, `/tokens/${mint}`, testInfo);
  await expect(page.getByRole('heading', { name: /Meteora Fixture/ }).first()).toBeVisible();
});
test('the home page lists the Meteora launch', async ({ page }, testInfo) => {
  await expectCleanPage(page, '/', testInfo);
  await expect(page.getByRole('link', { name: /Meteora Fixture/ })).toBeVisible();
});
test('the launch owner can open the fee-funded campaign page', async ({ page }, testInfo) => {
  await page
    .context()
    .addCookies([{ name: 'raid_session', value: ownerToken, url: 'http://localhost:3006' }]);
  await expectCleanPage(page, `/launch/${launchId}/campaign`, testInfo);
});
test('the campaign page does not exist for anyone else', async ({ page }) => {
  const response = await page.goto(`/launch/${launchId}/campaign`);
  expect(response?.status()).toBe(200);
  await expect(page.getByText('Meteora Fixture')).toHaveCount(0);
});
