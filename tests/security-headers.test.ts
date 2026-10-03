import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_HOSTS } from '../src/lib/image-hosts';

async function load() {
  vi.resetModules();
  return (await import('../next.config')).default;
}
async function headers(config: Awaited<ReturnType<typeof load>>) {
  const rules = await config.headers!();
  return Object.fromEntries(
    rules.find((r) => r.source === '/:path*')!.headers.map((h) => [h.key, h.value]),
  );
}
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('ALLOWED_DEV_ORIGINS', '');
});
afterEach(() => vi.unstubAllEnvs());
describe('security headers', () => {
  it('sets a Content-Security-Policy that locks down framing, plugins and images', async () => {
    const csp = (await headers(await load()))['Content-Security-Policy'];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("connect-src 'self'");
    const images = csp.split('; ').find((d) => d.startsWith('img-src'))!;
    for (const host of IMAGE_HOSTS) expect(images).toContain(`https://${host}`);
    expect(images).not.toMatch(/ https?: | \*/);
  });
  it('allows eval only outside production', async () => {
    expect((await headers(await load()))['Content-Security-Policy']).toContain("'unsafe-eval'");
    vi.stubEnv('NODE_ENV', 'production');
    expect((await headers(await load()))['Content-Security-Policy']).not.toContain("'unsafe-eval'");
  });
  it('sends HSTS only in production', async () => {
    expect((await headers(await load()))['Strict-Transport-Security']).toBeUndefined();
    vi.stubEnv('NODE_ENV', 'production');
    expect((await headers(await load()))['Strict-Transport-Security']).toBe(
      'max-age=63072000; includeSubDomains',
    );
  });
});
describe('allowedDevOrigins', () => {
  it('is empty unless configured', async () => {
    expect((await load()).allowedDevOrigins).toEqual([]);
  });
  it('reads a comma-separated list', async () => {
    vi.stubEnv('ALLOWED_DEV_ORIGINS', '192.168.1.5, foo.local,');
    expect((await load()).allowedDevOrigins).toEqual(['192.168.1.5', 'foo.local']);
  });
});
