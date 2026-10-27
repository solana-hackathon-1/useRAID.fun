import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T037 / blueprint §29: configuration is explicit. Every environment variable the application reads, and every
 * `*_ENABLED` feature flag it checks by name, must be documented in `.env.example`, so a deployer can see the
 * complete, default-off switch list.
 */
const root = resolve(__dirname, '..');
const STANDARD = new Set(['NODE_ENV', 'NEXT_RUNTIME', 'NEXT_PHASE', 'PORT', 'HOSTNAME', 'CI']);
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const documented = new Set(
  [
    ...readFileSync(join(root, '.env.example'), 'utf8').matchAll(
      /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
    ),
  ].map((m) => m[0]),
);
const referenced = new Map<string, string>();
for (const file of sources(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8');
  for (const [, name] of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g))
    if (!STANDARD.has(name)) referenced.set(name, file);
  for (const [, name] of text.matchAll(/process\.env\[\s*'([A-Z][A-Z0-9_]+)'\s*\]/g))
    if (!STANDARD.has(name)) referenced.set(name, file);
  for (const [, name] of text.matchAll(/\b(?:on|flag)\(\s*'([A-Z][A-Z0-9_]*_ENABLED)'\s*\)/g))
    referenced.set(name, file);
}
describe('environment documentation', () => {
  it('scans a realistic number of variables', () => {
    expect(referenced.size).toBeGreaterThan(40);
    expect(documented.size).toBeGreaterThan(40);
  });
  it('documents every environment variable and feature flag the application reads', () => {
    const missing = [...referenced.keys()].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });
  it('keeps every documented work-loop and notification flag default off', () => {
    // Older product flags (for example X tracking) keep their own defaults; the new core loop ships dark.
    const lines = readFileSync(join(root, '.env.example'), 'utf8').split('\n');
    const enabled = lines.filter((line) =>
      /^(WORK|NOTIFICATIONS)_[A-Z0-9_]*_ENABLED=(?!false\s*$)/.test(line),
    );
    expect(enabled).toEqual([]);
    expect(
      lines.filter((line) => /^WORK_[A-Z0-9_]*_ENABLED=false$/.test(line)).length,
    ).toBeGreaterThan(5);
  });
});
