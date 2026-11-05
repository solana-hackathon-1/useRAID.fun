import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T091 / blueprint §28.3: defend against server-side requests to internal services, credential-bearing endpoints
 * and unsafe redirects. Server code never fetches a caller-supplied URL: every server-side `fetch(` must begin with a
 * literal https:// plus a pinned provider host, so no input can change the scheme or host. Adding a provider host is a
 * deliberate change to this list (and needs its own adapter contract, R15). Browser code is excluded (components with
 * 'use client' and the repo's `*-client.ts` fetch wrappers): the browser can only reach the same origin because the CSP
 * sets `connect-src 'self'`, which the last test pins so the exclusion's premise cannot silently lapse.
 */
const ALLOWED_HOSTS = ['api.dexscreener.com', 'api.x.com', 'uploads.pinata.cloud'];
const root = resolve(__dirname, '..');
const src = join(root, 'src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const isClient = (text: string) =>
  /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(text);
/** The first argument text of every bare `fetch(` call (not `prefetch(`, `x.fetch(`, or `fetchMarket(`). */
function fetchCalls(text: string) {
  return [...text.matchAll(/(?<![\w.$])fetch\(\s*([^\n]{0,120})/g)].map((m) => m[1]);
}
const files = sources(src);
const isBrowser = (file: string) =>
  /-client\.tsx?$/.test(file) || isClient(readFileSync(file, 'utf8'));
const server = files.filter((file) => !isBrowser(file));

describe('server-side outbound fetch allowlist', () => {
  it('finds the server-side fetches it is supposed to guard', () => {
    const found = server.flatMap((file) => fetchCalls(readFileSync(file, 'utf8')));
    expect(found.length).toBeGreaterThanOrEqual(4);
  });
  it('only fetches a literal https URL on a pinned provider host', () => {
    const allowed = new RegExp(
      `^[\`'"]https://(?:${ALLOWED_HOSTS.map((h) => h.replaceAll('.', '\\.')).join('|')})/`,
    );
    const offenders = server.flatMap((file) =>
      fetchCalls(readFileSync(file, 'utf8'))
        .filter((argument) => !allowed.test(argument))
        .map((argument) => `${relative(root, file)}: fetch(${argument}`),
    );
    expect(offenders).toEqual([]);
  });
  it('uses every pinned host, so a stale entry cannot linger and widen the list', () => {
    const text = server.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const host of ALLOWED_HOSTS) expect(text, host).toContain(`https://${host}/`);
  });
  it("keeps the CSP connect-src at 'self', which is what confines browser fetches", () => {
    const config = readFileSync(join(root, 'next.config.ts'), 'utf8');
    expect(config).toContain(`"connect-src 'self'"`);
  });
});
