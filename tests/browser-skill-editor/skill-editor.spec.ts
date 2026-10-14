import { test, expect, type Page } from '@playwright/test';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { db } from '../../src/lib/db';
import { assertTestDatabase, truncateAll } from '../helpers/db-guard';
import { runCommandTransaction } from '../../src/lib/command-receipts-adapter';
import { publishSkillTaxonomy } from '../../src/skills/taxonomy-storage';
const baseURL = process.env.SKILL_EDITOR_TEST_URL || 'http://127.0.0.1:3023';
const id = 'synthetic-editor-catalog';
const apiPath = '/api/v1/admin/skill-taxonomies/' + id;
const enabled = process.env.SKILL_EDITOR_TEST_WRITES !== 'false';
let cookie: string, actor: { accountId: string; sessionHash: string };
const skill = {
  id: 'frontend',
  domain: 'software.frontend',
  name: 'Frontend',
  status: 'ACTIVE',
  aliases: ['frontend', 'web-ui'],
};
test.beforeEach(async ({ page }) => {
  assertTestDatabase();
  await truncateAll(db);
  const user = await db.user.create({
    data: { handle: 'synthetic-editor', role: 'ADMIN', xId: 'synthetic-taxonomy-editor' },
  });
  cookie = randomBytes(32).toString('base64url');
  actor = { accountId: user.id, sessionHash: createHash('sha256').update(cookie).digest('hex') };
  await db.session.create({
    data: {
      userId: user.id,
      tokenHash: actor.sessionHash,
      via: 'x',
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  await page.context().addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
});
async function publish(revision = 0, name = 'Frontend') {
  return runCommandTransaction(db, (tx) =>
    publishSkillTaxonomy(
      tx,
      {
        actor,
        input: { taxonomyId: id, expectedRevision: revision, skills: [{ ...skill, name }] },
        idempotencyKey: randomUUID(),
        requestId: 'synthetic-editor-fixture',
      },
      { allowNewWrites: true, canPublish: () => true },
    ),
  );
}
async function review(page: Page, name = 'Accessible frontend') {
  await page.getByLabel('Category name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Review publication', exact: true }),
  ).toBeVisible();
}
if (enabled) {
  test('admin edits actual saved categories, reviews changes and publishes one immutable version', async ({
    page,
  }, info) => {
    await publish();
    await page.goto('/admin/skills');
    await expect(page.getByRole('heading', { name: 'Skill catalog', exact: true })).toBeVisible();
    await expect(page.getByLabel('Skill ID', { exact: true })).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Skill domain', { exact: true })).toHaveAttribute('readonly', '');
    await page.getByLabel('Additional aliases', { exact: true }).fill('ACCESSIBLE-UI');
    await page.getByLabel('Category status', { exact: true }).selectOption('RETIRED');
    await review(page);
    expect(await db.skillTaxonomyVersion.count()).toBe(1);
    await page.getByRole('button', { name: 'Publish reviewed catalog', exact: true }).click();
    await expect(page.locator('form').getByRole('status')).toContainText('Catalog published');
    expect(await db.skillTaxonomyVersion.count()).toBe(2);
    expect(await db.outboxEvent.count()).toBe(0);
    await page.reload();
    await expect(page.getByLabel('Category name', { exact: true })).toHaveValue(
      'Accessible frontend',
    );
    await expect(page.getByText('accessible-ui', { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await page.screenshot({ path: info.outputPath('admin-catalog.png'), fullPage: true });
  });
  test('empty configured catalog starts with no seeded categories and adds explicit stable data', async ({
    page,
  }) => {
    await page.goto('/admin/skills');
    await expect(page.getByText('No catalog has been published.', { exact: true })).toBeVisible();
    expect(await page.getByLabel('Category name', { exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: 'Add category', exact: true }).click();
    await page.getByLabel('Skill ID', { exact: true }).fill('qa');
    await page.getByLabel('Skill domain', { exact: true }).fill('software.qa');
    await page.getByLabel('Aliases', { exact: true }).fill('quality-assurance, QA');
    await review(page, 'Quality assurance');
    await page.getByRole('button', { name: 'Publish reviewed catalog', exact: true }).click();
    await expect(page.locator('form').getByRole('status')).toContainText('Catalog published');
    expect(await db.skillTaxonomyVersion.count()).toBe(1);
  });
  test('invalid duplicate alias focuses error and preserves draft without publishing', async ({
    page,
  }) => {
    await publish();
    await page.goto('/admin/skills');
    await page.getByLabel('Category name', { exact: true }).fill('Keep my draft');
    await page.getByLabel('Additional aliases', { exact: true }).fill('WEB-UI');
    await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    await expect(page.locator('form').getByRole('alert')).toBeFocused();
    await expect(page.getByLabel('Category name', { exact: true })).toHaveValue('Keep my draft');
    expect(await db.skillTaxonomyVersion.count()).toBe(1);
  });
  test('unknown committed publication preserves exact original intent across rate and stale denials', async ({
    page,
  }) => {
    await publish();
    const attempts: { key: string | undefined; body: string | null }[] = [];
    await page.route('**' + apiPath, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempts.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postData(),
      });
      if (attempts.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        return route.abort();
      }
      if (attempts.length === 2)
        return route.fulfill({ status: 429, json: { error: { code: 'RATE_LIMITED' } } });
      if (attempts.length === 3)
        return route.fulfill({ status: 409, json: { error: { code: 'REVISION_CHANGED' } } });
      return route.continue();
    });
    await page.goto('/admin/skills');
    await review(page);
    await page.getByRole('button', { name: 'Publish reviewed catalog', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry publication', exact: true }),
    ).toBeEnabled();
    await expect(page.getByLabel('Category name', { exact: true })).toBeDisabled();
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Retry publication', exact: true }).click();
      if (i < 2)
        await expect(
          page.getByRole('button', { name: 'Retry publication', exact: true }),
        ).toBeEnabled();
    }
    await expect(page.locator('form').getByRole('status')).toContainText('Catalog published');
    expect(attempts.length).toBe(4);
    expect(attempts.every((a) => a.key === attempts[0].key && a.body === attempts[0].body)).toBe(
      true,
    );
    expect(await db.skillTaxonomyVersion.count()).toBe(2);
  });
  test('stale revision reloads current publisher state and preserves draft for renewed review', async ({
    page,
  }) => {
    await publish();
    await page.goto('/admin/skills');
    await review(page, 'Preserved draft');
    await publish(1, 'Concurrent label');
    await page.getByRole('button', { name: 'Publish reviewed catalog', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Reload saved revision', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Reload saved revision', exact: true }).click();
    await expect(page.getByLabel('Category name', { exact: true })).toHaveValue('Preserved draft');
    await expect(page.getByRole('region', { name: 'Saved catalog', exact: true })).toContainText(
      'Concurrent label',
    );
    await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    await page.getByRole('button', { name: 'Publish reviewed catalog', exact: true }).click();
    await expect(page.locator('form').getByRole('status')).toContainText('Catalog published');
    expect(await db.skillTaxonomyVersion.count()).toBe(3);
  });
  test('mismatched success acknowledgment stays unconfirmed and retries the original command', async ({
    page,
  }) => {
    await publish();
    let first = true;
    const bodies: string[] = [];
    await page.route('**' + apiPath, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postData()!);
      if (!first) return route.continue();
      first = false;
      const r = await route.fetch();
      const body = await r.json();
      body.taxonomy.skills[0].name = 'Wrong acknowledgment';
      return route.fulfill({ response: r, json: body });
    });
    await page.goto('/admin/skills');
    await review(page);
    await page.getByRole('button', { name: 'Publish reviewed catalog', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry publication', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Retry publication', exact: true }).click();
    await expect(page.locator('form').getByRole('status')).toContainText('Catalog published');
    expect(bodies[0]).toBe(bodies[1]);
    expect(await db.skillTaxonomyVersion.count()).toBe(2);
  });
  test('anonymous and wallet-only admins receive no editor catalog payload', async ({
    page,
    request,
  }) => {
    await publish(0, 'PRIVATE-EDITOR-SENTINEL');
    await page.context().clearCookies();
    const anonymous = await page.goto('/admin/skills');
    expect(await anonymous!.text()).not.toContain('PRIVATE-EDITOR-SENTINEL');
    await expect(page.getByRole('button', { name: 'Sign in with X', exact: true })).toBeVisible();
    await db.session.update({ where: { tokenHash: actor.sessionHash }, data: { via: 'wallet' } });
    await page.context().addCookies([{ name: 'raid_session', value: cookie, url: baseURL }]);
    const denied = await page.goto('/admin/skills');
    expect(await denied!.text()).not.toContain('PRIVATE-EDITOR-SENTINEL');
    const r = await request.get(apiPath, { headers: { cookie: 'raid_session=' + cookie } });
    expect(r.status()).toBe(403);
    expect(await r.text()).not.toContain('PRIVATE-EDITOR-SENTINEL');
  });
  test('controls remain disabled before hydration and prevent simultaneous duplicate publication', async ({
    page,
  }) => {
    await publish();
    await page.route('**/_next/**/*.js*', (r) => r.abort());
    await page.goto('/admin/skills');
    await expect(page.getByLabel('Category name', { exact: true })).toBeDisabled();
    await page.unroute('**/_next/**/*.js*');
    await page.reload();
    await review(page);
    let posts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes(apiPath)) posts++;
    });
    await page
      .getByRole('button', { name: 'Publish reviewed catalog', exact: true })
      .evaluate((b: HTMLButtonElement) => {
        b.click();
        b.click();
      });
    await expect(page.locator('form').getByRole('status')).toContainText('Catalog published');
    expect(posts).toBe(1);
    expect(await db.skillTaxonomyVersion.count()).toBe(2);
  });
  test('failed or foreign reload preserves stale draft and requires a valid current read before publication', async ({
    page,
  }) => {
    await publish();
    await page.goto('/admin/skills');
    await review(page, 'Keep stale draft');
    await publish(1, 'Other saved label');
    await page.getByRole('button', { name: 'Publish reviewed catalog', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Reload saved revision', exact: true }),
    ).toBeVisible();
    await page.route('**' + apiPath, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(),
        body = await response.json();
      body.publisherAccountId = 'other-current-admin';
      return route.fulfill({ response, json: body });
    });
    await page.getByRole('button', { name: 'Reload saved revision', exact: true }).click();
    await expect(page.locator('form').getByRole('alert')).toContainText('could not be loaded');
    await expect(page.getByLabel('Category name', { exact: true })).toHaveValue('Keep stale draft');
    await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeDisabled();
    expect(await db.skillTaxonomyVersion.count()).toBe(2);
    await page.unroute('**' + apiPath);
    await page.getByRole('button', { name: 'Reload saved revision', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeEnabled();
  });
  test('current role, allowlist identity and session revocation deny editor reads without leaking saved catalog', async ({
    page,
    request,
  }) => {
    await publish(0, 'PRIVATE-CATALOG-ACCESS');
    for (const kind of ['role', 'xId', 'session']) {
      await db.user.update({
        where: { id: actor.accountId },
        data: {
          role: kind === 'role' ? 'CREATOR' : 'ADMIN',
          xId: kind === 'xId' ? 'unlisted-editor' : 'synthetic-taxonomy-editor',
        },
      });
      if (kind === 'session') await db.session.delete({ where: { tokenHash: actor.sessionHash } });
      const response = await page.goto('/admin/skills');
      expect(await response!.text()).not.toContain('PRIVATE-CATALOG-ACCESS');
      const read = await request.get(apiPath, { headers: { cookie: 'raid_session=' + cookie } });
      expect(read.status()).toBe(kind === 'session' ? 401 : 403);
      expect(await read.text()).not.toContain('PRIVATE-CATALOG-ACCESS');
    }
  });
} else {
  test('disabled new publication retains readable actual categories and disabled editor controls', async ({
    page,
  }) => {
    await publish();
    await page.goto('/admin/skills');
    await expect(page.getByRole('region', { name: 'Saved catalog', exact: true })).toContainText(
      'Frontend',
    );
    await expect(
      page.getByText('Publication is currently unavailable.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Category name', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeDisabled();
    expect(await db.skillTaxonomyVersion.count()).toBe(1);
  });
}
test.afterAll(() => db.$disconnect());
