import { chromium, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const directory = new URL('.', import.meta.url);
const resource = JSON.parse(await readFile(new URL('preview-resources.json', directory), 'utf8'));
const browser = await chromium.launch();
const checks = [];
try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    await page.goto(resource.openUrl);
    const query = new URL(resource.url).search;
    const endpoint = new URL('/api/v1/admin/practice/review-assignments' + query, resource.url).href;
    const initial = await (await page.request.get(endpoint)).json();
    const original = initial.page.entries.find(entry => entry.currentState === 'ACTIVE');
    expect(original).toBeTruthy();
    const reason = 'Synthetic current-source preview ' + name + ' ' + Date.now();
    await page.getByLabel('Evaluator account ID', { exact: true }).fill(original.assignment.evaluatorAccountId);
    await page.getByLabel('Review purpose', { exact: true }).selectOption('ASSESSMENT_REVIEW');
    await page.getByLabel('Expiry (UTC)', { exact: true }).fill(new Date(Date.now() + 3600000).toISOString().slice(0, 16));
    await page.getByLabel('Appointment reason', { exact: true }).fill(reason);
    await page.getByRole('button', { name: 'Issue appointment', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Saved historical receipt', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh current appointments', exact: true }).click();
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    const afterIssue = await (await page.request.get(endpoint)).json();
    const issued = afterIssue.page.entries.find(entry => entry.assignment.reason === reason);
    expect(issued.currentState).toBe('ACTIVE');
    await page.getByLabel('Appointment to revoke', { exact: true }).selectOption(issued.assignment.id);
    await page.getByLabel('Revocation reason', { exact: true }).fill('Synthetic current-source preview reasoned revoke.');
    await page.getByRole('button', { name: 'Revoke appointment', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Saved historical receipt', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh current appointments', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Issue appointment', exact: true })).toBeEnabled();
    const afterRevoke = await (await page.request.get(endpoint)).json();
    const revoked = afterRevoke.page.entries.find(entry => entry.assignment.id === issued.assignment.id);
    expect(revoked.currentState).toBe('REVOKED');
    expect(revoked.assignment.state).toBe('ISSUED');
    expect(revoked.revocation.assignmentId).toBe(issued.assignment.id);
    checks.push({ name, actualIssueAndRevoke: true, keyboardIssue: true, explicitFiniteUtcExpiry: true, originalReceiptPreserved: true, refreshedRevocationObserved: true, syntheticAssignmentId: issued.assignment.id });
    await page.close();
  }
  await writeFile(new URL('preview-actions.json', directory), JSON.stringify({ sourceSha: '4cf779181588d0f808c5b294ddd6c0e5952b6b6a', checks, verifiedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(JSON.stringify(checks));
} finally { await browser.close(); }
