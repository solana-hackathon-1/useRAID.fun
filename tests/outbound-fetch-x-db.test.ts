import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { OutboundFetchError } from '../src/lib/outbound-fetch';
import { lookupPosts, ProviderError } from '../src/lib/providers/x';
import { createRaid } from '../src/lib/campaigns';
import { claimJob, JOB_MAX_ATTEMPTS } from '../src/lib/queue';
import { runJob } from '../src/lib/worker-jobs';
import { enqueueDue } from './helpers/queue';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

/** T091-W03: the X read path (bearer credential) refuses redirects and bounds the reply it parses. */
const suite = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
suite('X provider read hardening', () => {
  beforeAll(() => assertTestDatabase());
  beforeEach(async () => {
    await truncateAll(db);
    await db.settings.create({ data: { id: 'global', collectionEnabled: true } });
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
  it('refuses an oversized reply as a counted (non-deferred) failure and keeps the reservation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) }))),
    );
    const failure = await lookupPosts(['1']).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ deferred: false, status: 200, retryAfter: 60 });
    expect(failure.message).toContain('too_large');
    const usage = await db.providerUsage.findFirstOrThrow({ where: { provider: 'x' } });
    expect(usage.reservedCents).toBeGreaterThan(0);
  });
  it('refuses a non-JSON 200 as a counted (non-deferred) failure and keeps the reservation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>blocked</html>', { status: 200 })),
    );
    const failure = await lookupPosts(['1']).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ deferred: false, status: 200, retryAfter: 60 });
    expect(failure.message).toContain('invalid_json');
    const usage = await db.providerUsage.findFirstOrThrow({ where: { provider: 'x' } });
    expect(usage.reservedCents).toBeGreaterThan(0);
  });
  it('keeps the redirect refusal deferred and does not map other outbound errors to it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new OutboundFetchError('too_large', 'unexpected')),
    );
    const failure = await lookupPosts(['1']).catch((error) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure.message).not.toContain('redirected');
  });
  it('counts attempts for refused replies so the job dies at the attempt limit', async () => {
    const user = await db.user.create({ data: { xId: 'o-owner', handle: 'o', approved: true } });
    await db.xAccount.create({
      data: { userId: user.id, xUserId: 'o-owner', username: 'o', displayName: 'O' },
    });
    const raid = await createRaid(user, {
      title: 'Outbound campaign',
      description: 'An outbound fixture campaign.',
      mint: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
      name: 'Solana',
    });
    await db.raid.update({ where: { id: raid.id }, data: { status: 'ACTIVE' } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response('<html>blocked</html>', { status: 200 })),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const job = await enqueueDue('submission', 'submission:o:1', { raidId: raid.id, postId: '1' });
    for (let attempt = 1; attempt <= JOB_MAX_ATTEMPTS; attempt++) {
      await db.job.update({
        where: { id: job.id },
        data: { runAt: new Date(Date.now() - 60_000) },
      });
      const claimed = await claimJob();
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.attempts).toBe(attempt);
      await runJob(claimed!);
    }
    log.mockRestore();
    const final = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(final.attempts).toBe(JOB_MAX_ATTEMPTS);
    expect(final.failedAt).not.toBeNull();
  });
});
