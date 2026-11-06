import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { lookupPosts, ProviderError } from '../src/lib/providers/x';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

/** T091-W03: the X read path (bearer credential) refuses redirects and bounds the reply it parses. */
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
suite('X provider read hardening', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    vi.stubEnv('X_BEARER_TOKEN', 'fixture-bearer');
    config.demo = false;
    config.liveApproved = true;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('sends the bearer token with redirects refused', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal('fetch', fetcher);
    await lookupPosts(['1']);
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/api\.x\.com\/2\/tweets\?/);
    expect(init.headers.Authorization).toBe('Bearer fixture-bearer');
    expect(init.redirect).toBe('error');
  });
  it('turns a refused redirect into a deferred provider failure and settles nothing billable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }),
        ),
    );
    const failure = await lookupPosts(['1']).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ deferred: true });
    expect(failure.message).not.toContain('fixture-bearer');
    const usage = await db.providerUsage.findFirstOrThrow({ where: { provider: 'x' } });
    expect(usage.reservedCents).toBe(0);
  });
  it('refuses an oversized reply as a deferred provider failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) }))),
    );
    const failure = await lookupPosts(['1']).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ deferred: true });
  });
});
