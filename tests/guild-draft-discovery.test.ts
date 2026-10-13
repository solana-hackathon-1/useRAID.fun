import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('isolates eight owned Guild form cases and requires them before staging publication', async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:65432/useraid_test',
    NODE_ENV: 'test',
  };
  const discover = (config: string) =>
    execFileSync('node_modules/.bin/playwright', ['test', '--list', '--config=' + config], {
      encoding: 'utf8',
      env,
      timeout: 20000,
    });
  expect(discover('playwright.live.config.ts')).not.toContain('guild-drafts.spec.ts');
  expect(
    discover('playwright.guild-drafts.config.ts').match(/guild-drafts\.spec\.ts:/g),
  ).toHaveLength(8);
  const workflow = await readFile('.github/workflows/staging-image.yml', 'utf8');
  expect(workflow).toContain('test --config=playwright.guild-drafts.config.ts');
  expect(workflow.indexOf('test --config=playwright.guild-drafts.config.ts')).toBeLessThan(
    workflow.indexOf('Publish checked revision'),
  );
});
