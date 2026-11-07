import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanOutboundCalls } from './helpers/outbound-scan';

/**
 * T091 / blueprint §28.3: defend against server-side requests to internal services, credential-bearing endpoints
 * and unsafe redirects. Server code never fetches a caller-supplied URL: every server-side `providerFetch(` must begin
 * with a literal https:// plus a pinned provider host, so no input can change the scheme or host, and no server code
 * may use the global `fetch` or another HTTP client at all (it would follow redirects), so providerFetch is the only way out. Adding a provider host is a
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
const files = sources(src);
const isBrowser = (file: string) =>
  /-client\.tsx?$/.test(file) || isClient(readFileSync(file, 'utf8'));
const server = files.filter((file) => !isBrowser(file));

describe('server-side outbound fetch allowlist', () => {
  it('finds the server-side fetches it is supposed to guard', () => {
    const found = server.flatMap(
      (file) => scanOutboundCalls(readFileSync(file, 'utf8'), file).provider,
    );
    expect(found.length).toBeGreaterThanOrEqual(4);
  });
  it('only fetches a literal https URL on a pinned provider host', () => {
    const allowed = new RegExp(
      `^[\`'"]https://(?:${ALLOWED_HOSTS.map((h) => h.replaceAll('.', '\\.')).join('|')})/`,
    );
    const offenders = server.flatMap((file) =>
      scanOutboundCalls(readFileSync(file, 'utf8'), file)
        .provider.filter((argument) => !allowed.test(argument))
        .map((argument) => `${relative(root, file)}: providerFetch(${argument}`),
    );
    expect(offenders).toEqual([]);
  });
  it('sends nothing through a raw fetch( in server code: only providerFetch (redirects refused) may', () => {
    const wrapper = join(src, 'lib/outbound-fetch.ts'); // the one place allowed to hold the global
    expect(scanOutboundCalls(readFileSync(wrapper, 'utf8'), wrapper).raw).toEqual([
      'globalThis.fetch',
    ]);
    const offenders = server
      .filter((file) => file !== wrapper)
      .flatMap((file) =>
        scanOutboundCalls(readFileSync(file, 'utf8'), file).raw.map(
          (use) => `${relative(root, file)}: ${use}`,
        ),
      );
    expect(offenders).toEqual([]);
  });
  it('recognises a raw fetch( however it is spelled, and leaves providerFetch alone', () => {
    const pinned = `'https://api.x.com/2/tweets'`;
    expect(scanOutboundCalls(`await fetch(${pinned}, init)`).raw).toHaveLength(1);
    expect(scanOutboundCalls(`await globalThis.fetch(${pinned})`).raw).toHaveLength(1);
    expect(scanOutboundCalls(`await fetch(\n  ${pinned},\n)`).raw).toHaveLength(1);
    expect(scanOutboundCalls(`const r = fetch\n(${pinned})`).raw).toHaveLength(1);
    const clean = scanOutboundCalls(
      `await providerFetch(${pinned}); prefetch(x); client.fetch(y); function fetch(z) {}`,
    );
    expect(clean.raw).toEqual([]);
    expect(clean.provider).toHaveLength(1);
  });
  it.each([
    ['a cast receiver', `(globalThis as any).fetch(u)`],
    ['optional access', `globalThis?.fetch(u)`],
    ['element access', `globalThis['fetch'](u)`],
    ['an alias', `const f = fetch; f(u)`],
    ['fetch passed as a value', `run(fetch)`],
    ['.call', `fetch.call(null, u)`],
    ['optional call', `fetch?.(u)`],
    ['a comma expression', `(0, fetch)(u)`],
    ['destructuring', `const { fetch: f } = globalThis; f(u)`],
    ['a type argument', `fetch<Reply>(u)`],
    ['a comment between name and call', `fetch /* c */ (u)`],
    ['node https', `import https from 'node:https';`],
    ['node http', `import * as http from 'http';`],
    ['undici', `import { request } from 'undici';`],
    ['a dynamic import', `await import('node:https');`],
    ['require', `const h = require('https');`],
  ])('treats %s as a raw outbound call', (_name, source) => {
    expect(scanOutboundCalls(source).raw.length).toBeGreaterThan(0);
  });
  it('reads generic arrows and angle casts in a .ts file, so nothing below them hides', () => {
    const source = `const id = <T,>(x: T) => x;\nconst y = <any>z;\nfetch(u);`;
    expect(scanOutboundCalls(source, 'host.ts').raw).toHaveLength(1);
  });
  it('refuses to scan a file it cannot parse rather than reporting it clean', () => {
    expect(() => scanOutboundCalls('const = ;', 'broken.ts')).toThrow(/parse/);
  });
  it.each([
    ['an alias of providerFetch', `const pf = providerFetch; pf(u);`],
    ['providerFetch.call', `providerFetch.call(null, u);`],
    ['import equals', `import h = require('https');`],
    ['a re-export', `export { request } from 'undici';`],
    ['a star re-export', `export * from 'node:https';`],
    ['cross-fetch', `import f from 'cross-fetch';`],
  ])('treats %s as a raw outbound call', (_name, source) => {
    expect(scanOutboundCalls(source).raw.length).toBeGreaterThan(0);
  });
  it.each([
    ['a type position', `type F = typeof fetch; const x: F = y;`],
    ['a comment', `// fetch(x) is banned`],
    ['a string', `const s = 'call fetch(x)';`],
    ['a method on another object', `client.fetch(y);`],
    ['an object key', `const o = { fetch: 1 };`],
  ])('does not treat %s as a raw outbound call', (_name, source) => {
    expect(scanOutboundCalls(source).raw).toEqual([]);
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
