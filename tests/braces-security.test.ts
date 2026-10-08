import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolve the actual consumer chain rather than an unrelated direct install.
const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve('@next/eslint-plugin-next'));
const globRequire = createRequire(nextRequire.resolve('fast-glob'));
const matchRequire = createRequire(globRequire.resolve('micromatch'));
const braces = matchRequire('braces');
const glob = nextRequire('fast-glob');

describe('bounded brace processing in the lint dependency', () => {
  it.each(['compile', 'expand', 'stringify', 'parse'])(
    '%s rejects excessive brace nesting with a bounded syntax error',
    (method) => {
      const pattern = '{'.repeat(4000) + 'a,b' + '}'.repeat(4000);
      expect(() => braces[method](pattern)).toThrow(SyntaxError);
      expect(() => braces[method](pattern)).toThrow(/nesting exceeds maximum depth/);
    },
  );

  it.each(['compile', 'expand', 'stringify', 'parse'])(
    '%s bounds parentheses as well as braces',
    (method) => {
      const pattern = '('.repeat(4000) + 'text' + ')'.repeat(4000);
      expect(() => braces[method](pattern)).toThrow(/nesting exceeds maximum depth/);
    },
  );

  it.each(['compile', 'expand', 'stringify'])(
    '%s rejects a deeply nested supplied AST before recursion',
    (method) => {
      let node: unknown = { type: 'text', value: 'a' };
      for (let index = 0; index < 10000; index++) node = { type: 'root', nodes: [node] };
      expect(() => braces[method](node)).toThrow(/nesting exceeds maximum depth/);
    },
  );

  it('rejects cyclic AST children instead of exhausting the stack', () => {
    const node = { type: 'root', nodes: [] as unknown[] };
    node.nodes.push(node);
    for (const method of ['compile', 'expand', 'stringify']) {
      expect(() => braces[method](node)).toThrow(/nesting exceeds maximum depth|cyclic AST/);
    }
  });

  it('preserves ordinary alternatives, ranges, escapes and quoting', () => {
    expect(braces.expand('src/{app,components}/file.{ts,tsx}')).toEqual([
      'src/app/file.ts',
      'src/app/file.tsx',
      'src/components/file.ts',
      'src/components/file.tsx',
    ]);
    expect(braces.expand('{01..03}')).toEqual(['01', '02', '03']);
    expect(braces.compile('src/{app,components}/*.tsx')).toBe('src/(app|components)/*.tsx');
    expect(braces.expand('\\{literal\\}')).toEqual(['{literal}']);
    expect(braces.expand('"{literal}"')).toEqual(['{literal}']);
    expect(braces.expand('{a,{b,c}}')).toEqual(['a', 'b', 'c']);
    const boundary = '{'.repeat(128) + 'a' + '}'.repeat(128);
    expect(braces.stringify(boundary)).toBe(boundary);
    expect(() => braces.parse('{'.repeat(129) + 'a' + '}'.repeat(129))).toThrow(SyntaxError);
    // Escaped/quoted literal braces are not structural nesting.
    const literal = '\\{'.repeat(200);
    expect(braces.expand(literal)).toEqual(['{'.repeat(200)]);
    expect(braces.expand('"' + '{'.repeat(200) + '"')).toEqual(['{'.repeat(200)]);
    // A caller cannot use options to re-enable the vulnerable recursion.
    expect(() =>
      braces.compile('{'.repeat(200) + 'a' + '}'.repeat(200), { maxDepth: Infinity }),
    ).toThrow(SyntaxError);
  });

  it('the consuming glob finds only matching page files across alternatives and exclusions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'raid-glob-'));
    try {
      mkdirSync(join(directory, 'pages'));
      mkdirSync(join(directory, 'src/pages'), { recursive: true });
      writeFileSync(join(directory, 'pages/index.tsx'), '');
      writeFileSync(join(directory, 'src/pages/account.tsx'), '');
      writeFileSync(join(directory, 'src/pages/account.test.tsx'), '');
      expect(
        glob.sync(['{pages,src/pages}/**/*.tsx', '!**/*.test.tsx'], { cwd: directory }).sort(),
      ).toEqual(['pages/index.tsx', 'src/pages/account.tsx']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
