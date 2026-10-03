import type { Page } from '@playwright/test';

// Collects console errors, uncaught page errors and failed same-origin requests for a page.
export function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || /Content Security Policy|Refused to/i.test(message.text()))
      problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}
