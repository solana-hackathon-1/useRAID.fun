import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T089 / blueprint §28: hiding a button is not authorization. Static guard over every API route: a state-changing
 * method must reach an origin check, and no route may expose a generic "set the money/rank/state" mutation.
 */
const root = resolve(__dirname, '..');
const api = join(root, 'src/app/api');
function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routes(path) : name === 'route.ts' ? [path] : [];
  });
}
function localImports(file: string, source: string) {
  const found: string[] = [];
  for (const [, spec] of source.matchAll(/from\s+'([^']+)'/g)) {
    const base = spec.startsWith('@/')
      ? join(root, 'src', spec.slice(2))
      : spec.startsWith('.')
        ? resolve(dirname(file), spec)
        : null;
    if (!base) continue;
    for (const candidate of [base + '.ts', base + '.tsx', join(base, 'index.ts')])
      if (existsSync(candidate)) found.push(candidate);
  }
  return found;
}
/** The route, its direct local imports and theirs: host wiring modules call `checkOrigin` for the handlers. */
function reachable(file: string, depth = 2): string[] {
  const source = readFileSync(file, 'utf8');
  const next = depth > 0 ? localImports(file, source).flatMap((f) => reachable(f, depth - 1)) : [];
  return [file, ...next];
}
const MUTATING = /export\s+(?:async\s+)?(?:function|const)\s+(POST|PUT|PATCH|DELETE)\b/;
const files = routes(api);
describe('API route guard', () => {
  it('finds the routes it is supposed to guard', () => {
    expect(files.length).toBeGreaterThan(40);
  });
  it('requires every state-changing route to reach an origin check', () => {
    const unguarded = files
      .filter((file) => MUTATING.test(readFileSync(file, 'utf8')))
      .filter(
        (file) => !reachable(file).some((f) => readFileSync(f, 'utf8').includes('checkOrigin')),
      )
      .map((file) => relative(root, file));
    expect(unguarded).toEqual([]);
  });
  it('has no generic setPaid / setRank / setState style mutation route', () => {
    const generic =
      /(^|[-_/])(set|force|override|mark)[-_]?(paid|rank|state|status|score|balance|funded)/i;
    const offenders = files
      .map((file) => relative(api, dirname(file)))
      .filter((path) => generic.test(path));
    expect(offenders).toEqual([]);
  });
});
