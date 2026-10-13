import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('isolates onboarding from the general live server/cookie and executes it in staging CI', async () => {
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
  expect(discover('playwright.live.config.ts')).not.toContain('raider-onboarding.spec.ts');
  expect(
    discover('playwright.onboarding.config.ts').match(/raider-onboarding\.spec\.ts:/g),
  ).toHaveLength(8);
  const workflow = await readFile('.github/workflows/staging-image.yml', 'utf8');
  expect(workflow).toContain('test --config=playwright.onboarding.config.ts');
  expect(workflow.indexOf('test --config=playwright.onboarding.config.ts')).toBeLessThan(
    workflow.indexOf('Publish checked revision'),
  );
}, 60000);
