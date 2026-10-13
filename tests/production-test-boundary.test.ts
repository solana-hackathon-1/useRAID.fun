import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { expect, it } from 'vitest';
it('keeps production-visible TypeScript imports independent of the excluded test fixture tree', async () => {
  const ignore = await readFile('.dockerignore', 'utf8');
  expect(ignore).toMatch(/^tests\/?$/m);
  const files = execFileSync('rg', ['--files', 'src', 'scripts'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f));
  const invalid: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])(\.[^'"]+)\1/g)) {
      const target = relative(process.cwd(), resolve(dirname(file), match[2]));
      if (target === 'tests' || target.startsWith('tests/')) invalid.push(file + ' -> ' + target);
    }
  }
  expect(invalid).toEqual([]);
});
