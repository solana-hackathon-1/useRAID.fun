import fs from 'node:fs';
import { chromium, devices, expect } from '@playwright/test';
const directory = 'planning/task-evidence/T013-ownership-ui';
const resource = JSON.parse(fs.readFileSync(directory + '/preview-resources.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, options] of [
    ['desktop', { viewport: { width: 1440, height: 1000 } }],
    ['mobile', devices['iPhone 13']],
  ]) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    const response = await page.goto(resource.openUrl);
    await expect(page.getByRole('button', { name: 'Save finding', exact: true })).toBeEnabled();
    await expect(page.getByText(/Synthetic approved ownership guidance/)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Original submission', exact: true }),
    ).toBeVisible();
    const label = await page.locator('label[for=ownership-decision]').boundingBox();
    const input = await page.getByLabel('Finding', { exact: true }).boundingBox();
    if (!label || !input || label.y + label.height > input.y) throw Error('Finding control layout');
    if (await page.locator('body').evaluate((element) => element.scrollWidth > window.innerWidth))
      throw Error('Preview overflow');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: directory + '/preview-' + name + '.png', fullPage: true });
    if (response?.status() !== 200) throw Error('Preview unavailable');
    await context.close();
  }
  fs.writeFileSync(
    directory + '/preview-verified.json',
    JSON.stringify(
      {
        openUrl: resource.openUrl,
        caseUrl: resource.url,
        status: 200,
        source: resource.source,
        mode: 'development',
        synthetic: true,
        desktopMobileFormEnabled: true,
        approvedPolicyAndOriginalEvidenceVisible: true,
        labelsAboveControls: true,
        supervisorPid: Number(fs.readFileSync('/tmp/raid-ownership-ui-preview-owner.pid', 'utf8')),
        stopCommand:
          'kill ' + fs.readFileSync('/tmp/raid-ownership-ui-preview-owner.pid', 'utf8').trim(),
        retained: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Synthetic ownership form verified on desktop and mobile:', resource.openUrl);
} finally {
  await browser.close();
}
