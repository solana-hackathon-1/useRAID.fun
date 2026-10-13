import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, relative, join } from 'node:path';
import { expect, it } from 'vitest';
it('keeps production-visible TypeScript imports independent of the excluded test fixture tree', async () => {
  const ignore = await readFile('.dockerignore', 'utf8');
  expect(ignore).toMatch(/^tests\/?$/m);
  async function sources(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const groups = await Promise.all(
      entries.map((entry) => {
        const file = join(dir, entry.name);
        return entry.isDirectory()
          ? sources(file)
          : Promise.resolve(/\.tsx?$/.test(file) ? [file] : []);
      }),
    );
    return groups.flat();
  }
  const files = (await Promise.all(['src', 'scripts'].map(sources))).flat().sort();
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
