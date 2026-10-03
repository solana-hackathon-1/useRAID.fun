import { expect, type Page, type TestInfo } from '@playwright/test';
import { watchConsole } from './browser-console';

// Console errors, hydration warnings and CSP violations (reported by the browser as events and console text).
export async function watchPage(page: Page) {
  const problems = watchConsole(page);
  page.on('console', (message) => {
    if (message.type() === 'warning' && /hydrat|did not match/i.test(message.text()))
      problems.push(`hydration: ${message.text()}`);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) =>
      console.error(`csp violation: ${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  return problems;
}

// Loads a page and asserts it is clean; at mobile width it also rejects horizontal scrolling.
export async function expectCleanPage(
  page: Page,
  path: string,
  testInfo: TestInfo,
  options: { status?: number } = {},
) {
  const problems = await watchPage(page);
  const response = await page.goto(path);
  expect(response?.status()).toBe(options.status ?? 200);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('h1').first()).toBeVisible();
  if (testInfo.project.name === 'mobile')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${path} scrolls horizontally on mobile`,
    ).toBe(true);
  expect(problems.filter((p) => !/status of 404/.test(p))).toEqual([]);
}
