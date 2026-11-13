import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLAG_CATALOG, validateRuntimeConfig } from '../src/config-validation/index';

const dir = 'src/config-validation';
const exampleEnv = () =>
  new Map(
    [...readFileSync('.env.example', 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map(
      (m) => [m[1]!, m[2]!] as const,
    ),
  );

describe('T037 configuration validator reuse contract (R15, R16)', () => {
  it('is portable: no environment, framework, database, SDK or app import', () => {
    expect(readdirSync(dir).sort()).toEqual(['flags.ts', 'index.ts', 'snapshot.ts', 'validate.ts']);
    for (const name of readdirSync(dir)) {
      const source = readFileSync(join(dir, name), 'utf8');
      expect(source, name).not.toMatch(
        /process\.env|globalThis|Date\.now|new Date|@\/|@prisma|@solana|next\/|lib\//,
      );
      for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g))
        expect(match[1], name).toMatch(/^\.\//);
    }
  });

  it('keeps the catalog and .env.example in step, with every switch documented off by default', () => {
    const documented = exampleEnv();
    const switches = [...documented.keys()].filter(
      (name) =>
        /_(ENABLED|APPROVED)$/.test(name) ||
        ['DEMO_MODE', 'STUDIO_SANDBOX', 'ALLOW_REMOTE_TEST_DB'].includes(name),
    );
    expect(FLAG_CATALOG.map((f) => f.name).sort()).toEqual(switches.sort());
    for (const flag of FLAG_CATALOG) {
      const expected =
        flag.name === 'X_TRACKING_V2_ENABLED'
          ? 'true'
          : flag.name === 'DEMO_MODE'
            ? 'true'
            : 'false';
      expect(documented.get(flag.name), flag.name).toBe(expected);
    }
    expect(new Set(FLAG_CATALOG.map((f) => f.name)).size).toBe(FLAG_CATALOG.length);
  });

  it('no documented non-switch setting is mistaken for a misspelled switch', () => {
    const switches = new Set(FLAG_CATALOG.map((f) => f.name));
    const env = Object.fromEntries(
      [...exampleEnv()]
        .filter(([name]) => !switches.has(name) && name !== 'RAID_ENVIRONMENT')
        .map(([name]) => [name, 'x']),
    );
    expect(validateRuntimeConfig(env, 'web').violations).toEqual([]);
  });

  it('every switch the source reads is catalogued', () => {
    const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.tsx?$/.test(f));
    const read = new Set<string>();
    for (const file of files)
      for (const m of readFileSync(file, 'utf8').matchAll(
        /(?:\benv\.|process\.env,\s*['"])([A-Z][A-Z0-9_]*_(?:ENABLED|APPROVED))\b/g,
      ))
        read.add(m[1]!);
    const known = new Set(FLAG_CATALOG.map((f) => f.name));
    expect([...read].filter((name) => !known.has(name)).sort()).toEqual([]);
  });

  it('is documented in module reuse and has a passing standalone consuming host', () => {
    const reuse = readFileSync('docs/raid-module-reuse.md', 'utf8');
    expect(reuse).toContain('## Configuration validation (config-validation)');
    expect(reuse).toContain('examples/config-validation');
    const out = execFileSync('node', ['--import', 'tsx', 'host.ts'], {
      cwd: 'examples/config-validation',
      encoding: 'utf8',
    });
    expect(out).toContain('all checks passed');
  });
});
