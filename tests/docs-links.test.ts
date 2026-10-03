import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const docs = ['README.md', ...readdirSync(join(root, 'docs')).map((name) => `docs/${name}`)].filter(
  (name) => name.endsWith('.md'),
);
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts as Record<
  string,
  string
>;

function slugs(markdown: string) {
  return new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) =>
      m[1]
        .toLowerCase()
        .replace(/[`*_]/g, '')
        .replace(/[^a-z0-9 -]/g, '')
        .trim()
        .replace(/ /g, '-'),
    ),
  );
}

describe('documentation', () => {
  for (const doc of docs) {
    const text = readFileSync(join(root, doc), 'utf8');

    it(`${doc}: relative links and anchors resolve`, () => {
      const broken: string[] = [];
      for (const m of text.matchAll(/\]\(((?!https?:|mailto:)[^)\s]+)\)/g)) {
        const [file, anchor] = m[1].split('#');
        const target = file ? resolve(dirname(join(root, doc)), file) : join(root, doc);
        if (!existsSync(target)) broken.push(m[1]);
        else if (
          anchor &&
          target.endsWith('.md') &&
          !slugs(readFileSync(target, 'utf8')).has(anchor)
        )
          broken.push(m[1]);
      }
      expect(broken).toEqual([]);
    });

    it(`${doc}: every npm script it names exists`, () => {
      const missing = [...text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)]
        .map((m) => m[1])
        .filter((name) => !(name in scripts));
      expect(missing).toEqual([]);
    });
  }

  it('states the release policies', () => {
    const read = (name: string) => readFileSync(join(root, name), 'utf8');
    const tracking = read('docs/x-tracking.md');
    expect(tracking).toMatch(/default and is on unless `X_TRACKING_V2_ENABLED=false`/);
    expect(tracking).toMatch(/required\*\* for Creator Studio/);
    expect(tracking).toMatch(/Reconciliation of signed transactions runs in the worker regardless/);
    expect(tracking).toMatch(/Launchpad fee rewards are \*\*uncapped\*\*/);
    const operations = read('docs/operations.md');
    expect(operations).toMatch(/Four-eyes approval .*\*\*deferred\*\*/);
    expect(operations).toMatch(/## Operator checklist/);
    expect(operations).toMatch(/media:backfill/);
    expect(operations).toMatch(/sites\/coming-soon/);
    expect(operations).toMatch(/VALIDATE CONSTRAINT/);
  });
});
