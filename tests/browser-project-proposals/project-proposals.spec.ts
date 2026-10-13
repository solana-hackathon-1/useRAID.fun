import { test, expect } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { db } from '../../src/lib/db';
import { saveGuildDraft } from '../../src/guild-profiles/draft-storage';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
const baseURL = process.env.PROJECT_PROPOSAL_BROWSER_URL || 'http://localhost:3018';
const candidate = {
  networkIdentity: 'synthetic-genesis',
  mint: bs58.encode(new Uint8Array(32).fill(17)),
  tokenProgram: bs58.encode(new Uint8Array(32).fill(18)),
};
let draftId: string, cookie: string;
test.beforeEach(async ({ page }) => {
  assertTestDatabase();
  await truncateAll(db);
  const user = await db.user.create({ data: { handle: 'synthetic_project_form' } });
  cookie = randomBytes(32).toString('base64url');
  const sessionHash = createHash('sha256').update(cookie).digest('hex');
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: sessionHash,
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const result = await runCommandTransaction(db, (tx) =>
    saveGuildDraft(
      tx,
      {
        actor: { accountId: user.id, actorAccountId: user.id, sessionHash },
        input: {
          guildDraftId: null,
          expectedRevision: 0,
          profile: {
            name: 'Synthetic private project',
            slug: 'synthetic-' + randomUUID(),
            description: 'Private project preparation',
          },
        },
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      },
      { allowNewWrites: true },
    ),
  );
  draftId = result.draft.id;
  await page.context().addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
});
test.afterAll(async () => {
  await truncateAll(db);
  await db.$disconnect();
});
async function fill(page: import('@playwright/test').Page) {
  await page
    .getByLabel('Claimed network identity', { exact: true })
    .fill(candidate.networkIdentity);
  await page.getByLabel('Token mint', { exact: true }).fill(candidate.mint);
  await page.getByLabel('Token program', { exact: true }).fill(candidate.tokenProgram);
  await page
    .getByLabel('Supporting reference URLs', { exact: true })
    .fill('https://public.example/project');
}
test('owner reaches pending existing-project preparation, saves, edits and reloads private records', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/creator/guild-drafts/' + draftId + '/project');
  await expect(
    page.getByRole('heading', { name: 'Private existing-project proposal', exact: true }),
  ).toBeVisible();
  await fill(page);
  await page.getByRole('button', { name: 'Save private proposal', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Proposal saved');
  await expect(page.getByText('Pending verification', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Founder control has not been verified.', { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Supporting reference URLs', { exact: true })
    .fill('https://public.example/updated');
  await page.getByRole('button', { name: 'Save private proposal', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Proposal saved');
  await page.reload();
  await expect(page.getByLabel('Supporting reference URLs', { exact: true })).toHaveValue(
    'https://public.example/updated',
  );
  const [row] = await db.$queryRawUnsafe<{ versions: number; outbox: number }[]>(
    'SELECT (SELECT count(*)::int FROM "GuildProjectProposalVersion") AS versions,(SELECT count(*)::int FROM "OutboxEvent") AS outbox',
  );
  expect(row).toEqual({ versions: 2, outbox: 0 });
  expect(await db.participant.count()).toBe(0);
  expect(errors).toEqual([]);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('project-proposal.png'), fullPage: true });
});

test('preserves the original proposal intent through committed lost acknowledgment and temporary rate denial', async ({
  page,
}) => {
  await page.goto('/creator/guild-drafts/' + draftId + '/project');
  await fill(page);
  const attempts: { key: string | null; body: unknown }[] = [];
  await page.route('**/api/v1/guild-drafts/*/project-proposal', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    attempts.push({
      key: route.request().headers()['idempotency-key'] ?? null,
      body: route.request().postDataJSON(),
    });
    if (attempts.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort('failed');
    } else if (attempts.length === 2)
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'RATE_LIMITED' } }),
      });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Save private proposal', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('same proposal');
  await expect(page.locator('form').getByRole('alert')).toBeFocused();
  await expect(page.getByLabel('Token mint', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('same proposal');
  await expect(page.getByLabel('Token mint', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Proposal saved');
  expect(attempts).toHaveLength(3);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2]).toEqual(attempts[0]);
  const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM "GuildProjectProposalVersion"',
  );
  expect(row.n).toBe(1);
  expect(await db.commandReceipt.count()).toBe(2);
});
test('preserves local proposal fields when a newer proposal wins and reloads saved revisions before a reviewed retry', async ({
  page,
}) => {
  await page.goto('/creator/guild-drafts/' + draftId + '/project');
  await fill(page);
  const apiPath = '/api/v1/guild-drafts/' + draftId + '/project-proposal';
  const changed = await page.request.post(apiPath, {
    headers: { Origin: baseURL, 'Idempotency-Key': randomUUID() },
    data: {
      expectedDraftRevision: 1,
      expectedProposalRevision: 0,
      candidateToken: { chain: 'SOLANA', kind: 'TOKEN', ...candidate },
      publicEvidenceRefs: ['https://public.example/another-save'],
    },
  });
  expect(changed.status()).toBe(200);
  await page.getByRole('button', { name: 'Save private proposal', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('Reload');
  await expect(page.getByLabel('Supporting reference URLs', { exact: true })).toHaveValue(
    'https://public.example/project',
  );
  await page.getByRole('button', { name: 'Reload saved revision', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText(
    'Your proposal is preserved',
  );
  await expect(
    page.getByText('https://public.example/another-save', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Supporting reference URLs', { exact: true })).toHaveValue(
    'https://public.example/project',
  );
  await page.getByRole('button', { name: 'Save private proposal', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Proposal saved');
  const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM "GuildProjectProposalVersion"',
  );
  expect(row.n).toBe(2);
});
test('keeps anonymous and foreign pages private without fields or saved references', async ({
  page,
  browser,
}) => {
  await page.goto('/creator/guild-drafts/' + draftId + '/project');
  await fill(page);
  await page.getByRole('button', { name: 'Save private proposal', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Proposal saved');
  const context = await browser.newContext(),
    other = await context.newPage();
  try {
    await other.goto(baseURL + '/creator/guild-drafts/' + draftId + '/project');
    await expect(other.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(other.getByLabel('Token mint', { exact: true })).toHaveCount(0);
    expect(await other.content()).not.toContain(candidate.mint);
    const user = await db.user.create({ data: { handle: 'synthetic_other_proposal' } }),
      otherCookie = randomBytes(32).toString('base64url');
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(otherCookie).digest('hex'),
        via: 'wallet',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await context.addCookies([{ name: 'raid_session', value: otherCookie, url: baseURL }]);
    for (const id of [draftId, randomUUID()]) {
      await other.goto(baseURL + '/creator/guild-drafts/' + id + '/project');
      await expect(other.locator('.studio').getByRole('alert')).toContainText(
        'could not be loaded',
      );
      await expect(other.getByLabel('Token mint', { exact: true })).toHaveCount(0);
      expect(await other.content()).not.toContain(candidate.mint);
      expect(await other.content()).not.toContain('https://public.example/project');
    }
  } finally {
    await context.close();
  }
});
test('finds the proposal from the own saved draft and preserves fields on invalid reference input', async ({
  page,
}) => {
  await page.goto('/creator/guild-drafts/' + draftId);
  await page.getByRole('link', { name: 'Prepare existing-project proposal', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Private existing-project proposal', exact: true }),
  ).toBeVisible();
  await fill(page);
  await page
    .getByLabel('Supporting reference URLs', { exact: true })
    .fill('https://name:secret@public.example/');
  await page.getByRole('button', { name: 'Save private proposal', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('without credentials');
  await expect(page.locator('form').getByRole('alert')).toBeFocused();
  await expect(page.getByLabel('Token mint', { exact: true })).toHaveValue(candidate.mint);
  const [row] = await db.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM "GuildProjectProposalVersion"',
  );
  expect(row.n).toBe(0);
  await page
    .getByLabel('Supporting reference URLs', { exact: true })
    .fill('https://public.example/corrected');
  await page.getByRole('button', { name: 'Save private proposal', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Proposal saved');
});
