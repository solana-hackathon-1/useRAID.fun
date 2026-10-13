import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('isolates ten desktop/mobile proposal journeys and requires both workflow gates before publication', async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:65432/useraid_test',
    NODE_ENV: 'test',
  };
  const list = (config: string) =>
    execFileSync('node_modules/.bin/playwright', ['test', '--list', '--config=' + config], {
      encoding: 'utf8',
      env,
      timeout: 20000,
    });
  expect(list('playwright.live.config.ts')).not.toContain('project-proposals.spec.ts');
  expect(
    list('playwright.project-proposals.config.ts').match(/project-proposals\.spec\.ts:/g),
  ).toHaveLength(10);
  for (const name of ['.github/workflows/staging-image.yml', '.github/workflows/checks.yml']) {
    const source = await readFile(name, 'utf8');
    const step = 'test --config=playwright.project-proposals.config.ts';
    expect(source).toContain(step);
    expect(source.indexOf(step)).toBeLessThan(
      source.indexOf(name.includes('staging') ? 'Build production image' : 'Production build'),
    );
  }
});
