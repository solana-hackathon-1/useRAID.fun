import { test, expect, type Page } from '@playwright/test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { db } from '../../src/lib/db';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy } from '../../src/skills/taxonomy-storage';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
const baseURL = process.env.SKILL_FORM_BROWSER_URL || 'http://127.0.0.1:3021',
  taxonomyId = 'synthetic-browser-catalog';
let cookie: string, ownerId: string, admin: { accountId: string; sessionHash: string };
test.beforeEach(async ({ page }) => {
  assertTestDatabase();
  await truncateAll(db);
  for (let i = 0; i < 2; i++) {
    const u = await db.user.create({
      data: {
        handle: 'synthetic-form-' + randomUUID(),
        role: i === 0 ? 'ADMIN' : 'CREATOR',
        xId: i === 0 ? 'synthetic-admin-' + randomUUID() : null,
      },
    });
    const token = randomBytes(32).toString('base64url'),
      sessionHash = createHash('sha256').update(token).digest('hex');
    await db.session.create({
      data: {
        userId: u.id,
        tokenHash: sessionHash,
        via: i === 0 ? 'x' : 'wallet',
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    await db.participant.create({
      data: {
        accountId: u.id,
        provisionActorAccountId: u.id,
        provisionRequestId: 'synthetic-form-provision',
      },
    });
    if (i === 0) admin = { accountId: u.id, sessionHash };
    else {
      cookie = token;
      ownerId = u.id;
    }
  }
  await publish();
  await page.context().addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
});
async function publish(revision = 0, retired = false) {
  await runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor: admin,
        input: {
          taxonomyId,
          expectedRevision: revision,
          skills: [
            {
              id: 'frontend',
              domain: 'software.frontend',
              name: 'Frontend',
              status: retired ? 'RETIRED' : 'ACTIVE',
              aliases: ['frontend'],
            },
            {
              id: 'solana',
              domain: 'blockchain.solana',
              name: 'Solana programs',
              status: 'ACTIVE',
              aliases: ['solana-programs'],
            },
          ],
        },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-browser-publish',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
}
async function fill(page: Page, text = 'I build accessible interfaces') {
  await page.getByLabel('Self-reported experience', { exact: true }).fill(text);
  await page
    .getByLabel('Private proof URLs', { exact: true })
    .fill('https://public.example/portfolio');
}
test('owner discovers actual categories and saves a private unverified claim', async ({
  page,
}, info) => {
  const response = await page.goto('/raider/skills');
  expect(response?.status()).toBe(200);
  await page.getByRole('link', { name: 'Frontend', exact: true }).click();
  await fill(page);
  await page.getByRole('button', { name: 'Save private claim', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Claim saved');
  await expect(
    page.getByText('Self-reported claim; this claim does not verify a rank.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Self-reported experience', { exact: true })).toHaveValue(
    'I build accessible interfaces',
  );
  expect(await db.skillClaimVersion.count()).toBe(1);
  expect(await db.outboxEvent.count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    scrollTo(0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.screenshot({ path: info.outputPath('private-skill-claim.png'), fullPage: true });
});
test('anonymous and revoked sessions receive no private claim or proof bytes', async ({ page }) => {
  await page.goto('/raider/skills/frontend');
  await fill(page, 'PRIVATE-SKILL-SENTINEL');
  await page.getByRole('button', { name: 'Save private claim', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Claim saved');
  await page.context().clearCookies();
  let response = await page.goto('/raider/skills/frontend');
  expect(await response!.text()).not.toContain('PRIVATE-SKILL-SENTINEL');
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await page.context().addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
  await db.session.deleteMany({ where: { userId: ownerId } });
  response = await page.goto('/raider/skills/frontend');
  expect(await response!.text()).not.toContain('public.example/portfolio');
});
test('validates fields accessibly without losing the draft or sending a command', async ({
  page,
}) => {
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/v1/skill-claims/')) posts++;
  });
  await page.goto('/raider/skills/frontend');
  await page.getByLabel('Self-reported experience', { exact: true }).fill('Keep this text');
  await page.getByLabel('Private proof URLs', { exact: true }).fill('http://unsafe.example');
  await page.getByRole('button', { name: 'Save private claim', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toBeFocused();
  expect(posts).toBe(0);
  await expect(page.getByLabel('Self-reported experience', { exact: true })).toHaveValue(
    'Keep this text',
  );
});
test('retries a committed lost acknowledgment with the original key and body through rate denial', async ({
  page,
}) => {
  let attempts = 0;
  const requests: { key: string | null; body: string | null }[] = [];
  await page.route('**/api/v1/skill-claims/frontend', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    requests.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    if (attempts === 1) {
      const real = await route.fetch();
      expect(real.status()).toBe(200);
      return route.abort();
    }
    if (attempts === 2)
      return route.fulfill({
        status: 429,
        json: { error: { code: 'RATE_LIMITED', retryable: true } },
      });
    return route.continue();
  });
  await page.goto('/raider/skills/frontend');
  await fill(page);
  await page.getByRole('button', { name: 'Save private claim', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('could not be confirmed');
  await expect(page.getByLabel('Self-reported experience', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('Wait');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Claim saved');
  expect(requests).toHaveLength(3);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]).toEqual(requests[0]);
  expect(await db.skillClaimVersion.count()).toBe(1);
});
test('rereads a known stale catalog while preserving input for explicit review and new intent', async ({
  page,
}) => {
  await page.goto('/raider/skills/frontend');
  await fill(page, 'Preserve my draft');
  await publish(1);
  await page.getByRole('button', { name: 'Save private claim', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('changed');
  await expect(
    page.getByRole('button', { name: 'Save private claim', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Reload saved revision', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Review');
  await expect(page.getByLabel('Self-reported experience', { exact: true })).toHaveValue(
    'Preserve my draft',
  );
  await page.getByRole('button', { name: 'Save private claim', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Claim saved');
  expect((await db.skillClaimVersion.findFirst())?.taxonomyRevision).toBe(2);
});
test('rejects a mismatched success snapshot and retries the same committed intent', async ({
  page,
}) => {
  let count = 0;
  await page.route('**/api/v1/skill-claims/frontend', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (++count > 1) return route.continue();
    const real = await route.fetch(),
      body = await real.json();
    body.claim.claimedLevel = 'Different intent';
    return route.fulfill({ status: 200, json: body });
  });
  await page.goto('/raider/skills/frontend');
  await fill(page);
  await page.getByRole('button', { name: 'Save private claim', exact: true }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('could not be confirmed');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Claim saved');
  expect(await db.skillClaimVersion.count()).toBe(1);
});
test('keeps a retired saved category readable and excludes it from new claim discovery', async ({
  page,
}) => {
  await page.goto('/raider/skills/frontend');
  await fill(page);
  await page.getByRole('button', { name: 'Save private claim', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Claim saved');
  await publish(1, true);
  await page.reload();
  await expect(page.getByLabel('Self-reported experience', { exact: true })).toHaveValue(
    'I build accessible interfaces',
  );
  await expect(
    page.getByRole('button', { name: 'Save private claim', exact: true }),
  ).toBeDisabled();
  await page.goto('/raider/skills');
  await expect(page.getByRole('link', { name: 'Frontend', exact: true })).toHaveCount(0);
});

test('another canonical account receives no private claim bytes from the same skill URL', async ({
  page,
}) => {
  await page.goto('/raider/skills/frontend');
  await fill(page, 'PRIVATE-OWNER-SKILL');
  await page.getByRole('button', { name: 'Save private claim', exact: true }).click();
  await expect(page.locator('form').getByRole('status')).toContainText('Claim saved');
  const other = await db.user.create({ data: { handle: 'synthetic-foreign-' + randomUUID() } });
  const token = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      userId: other.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      via: 'wallet',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  await db.participant.create({
    data: {
      accountId: other.id,
      provisionActorAccountId: other.id,
      provisionRequestId: 'synthetic-foreign-provision',
    },
  });
  await page.context().clearCookies();
  await page.context().addCookies([{ name: 'raid_session', value: token, url: baseURL }]);
  const response = await page.goto('/raider/skills/frontend');
  expect(await response!.text()).not.toContain('PRIVATE-OWNER-SKILL');
  await expect(page.getByLabel('Self-reported experience', { exact: true })).toHaveValue('');
  await expect(
    page.getByText('No claim has been saved for this skill.', { exact: true }),
  ).toBeVisible();
});
test('concurrent form activation dispatches one command and records one claim version', async ({
  page,
}) => {
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/v1/skill-claims/')) posts++;
  });
  await page.goto('/raider/skills/frontend');
  await fill(page);
  await page.locator('form').evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
    (form as HTMLFormElement).requestSubmit();
  });
  await expect(page.locator('form').getByRole('status')).toContainText('Claim saved');
  expect(posts).toBe(1);
  expect(await db.skillClaimVersion.count()).toBe(1);
});

test('private edits stay disabled until client scripts and hydration are ready', async ({
  page,
}) => {
  await page.route('**/_next/**/*.js*', (route) => route.abort());
  await page.goto('/raider/skills/frontend');
  await expect(page.getByLabel('Self-reported experience', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Save private claim', exact: true }),
  ).toBeDisabled();
  await page.unroute('**/_next/**/*.js*');
  await page.reload();
  await expect(page.getByLabel('Self-reported experience', { exact: true })).toBeEnabled();
});
