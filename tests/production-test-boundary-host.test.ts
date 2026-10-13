import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
it('checks the actual production imports with no external search command on PATH', () => {
  const output = execFileSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/production-test-boundary.test.ts',
      '--reporter=dot',
    ],
    { encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 20000 },
  );
  expect(output).toMatch(/1 passed/);
}, 30000);
