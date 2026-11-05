import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T089 / blueprint §26.1, I05 and AC69: every retryable `/api/v1` state change is scoped by an `Idempotency-Key` so a
 * duplicate command, webhook or retry cannot create a second business outcome and a reused key with another payload
 * is an explicit conflict. Static guard: each v1 route that exports a mutating method must reach code that reads the
 * `idempotency-key` header. A new write route without it must either read the header or be added to EXEMPT with a reason.
 */
const EXEMPT: Record<string, string> = {};
const root = resolve(__dirname, '..');
const api = join(root, 'src/app/api/v1');
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
function reachable(file: string, depth = 3, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const next =
    depth > 0 ? localImports(file, source).flatMap((f) => reachable(f, depth - 1, seen)) : [];
  return [file, ...next];
}
const MUTATING = /export\s+(?:async\s+)?(?:function|const)\s+(POST|PUT|PATCH|DELETE)\b/;
const READS_KEY = /headers\.get\(\s*['"]idempotency-key['"]\s*\)/i;
const writes = routes(api).filter((file) => MUTATING.test(readFileSync(file, 'utf8')));

describe('v1 write routes require an Idempotency-Key', () => {
  it('finds the write routes it is supposed to guard', () => {
    expect(writes.length).toBeGreaterThanOrEqual(30);
  });
  it('reaches a read of the idempotency-key header from every mutating v1 route', () => {
    const missing = writes
      .map((file) => relative(root, file))
      .filter((file) => !(file in EXEMPT))
      .filter(
        (file) => !reachable(join(root, file)).some((f) => READS_KEY.test(readFileSync(f, 'utf8'))),
      );
    expect(missing).toEqual([]);
  });
  it('keeps every exemption justified and still pointing at a real write route', () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, file).toBeGreaterThan(20);
      expect(
        writes.map((f) => relative(root, f)),
        file,
      ).toContain(file);
    }
  });
});
