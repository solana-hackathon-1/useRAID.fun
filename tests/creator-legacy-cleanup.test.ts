import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { startAttempt, claimAttempt, completeConnection } from '../src/lib/x-oauth';
import { sandboxUser } from '../src/lib/studio-sandbox';
import { assertTestDatabase, truncateAll } from './helpers/db-guard';

// The real sandbox gate requires the separate Studio database; this suite uses the dedicated test one.
vi.mock('../src/lib/studio-mode', () => ({ studioSandbox: () => true }));

// Real-database form: the retired creator fields (approved, affiliation) are never authentication
// authority and sign-in must not rewrite them. Lock planning is exercised by the identity protocol.
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('retired creator metadata is not authentication authority', () => {
  const profile = { id: '123', username: 'creator', name: 'Creator' };
  beforeAll(() => {
    assertTestDatabase();
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
  });
  beforeEach(async () => {
    await truncateAll(db);
    vi.stubEnv('X_CLIENT_ID', 'fixture-client');
    vi.stubEnv('X_CLIENT_SECRET', 'fixture-secret');
    vi.stubEnv('ADMIN_X_IDS', '');
    vi.stubEnv('X_ADMIN_USER_ID', '');
    // Old installations may still supply this retired setting; it must have no effect.
    vi.stubEnv('LOCAL_AUTO_APPROVE_CREATORS', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => db.$disconnect());
  async function signIn() {
    const { state } = await startAttempt(null);
    return completeConnection(await claimAttempt(state, null), profile);
  }

  it.each([false, true])(
    'X sign-in writes identity/role, not approval (admin=%s)',
    async (admin) => {
      if (admin) vi.stubEnv('ADMIN_X_IDS', profile.id);
      await signIn();
      const user = await db.user.findUniqueOrThrow({ where: { xId: profile.id } });
      expect(user).toMatchObject({
        handle: 'creator',
        role: admin ? 'ADMIN' : 'CREATOR',
        approved: false,
        affiliation: '',
      });
      expect(await db.session.count({ where: { userId: user.id, via: 'x' } })).toBe(1);
    },
  );
  it('demotes an existing administrator without rewriting retired fields', async () => {
    await db.user.create({
      data: {
        xId: profile.id,
        handle: 'creator',
        role: 'ADMIN',
        approved: true,
        affiliation: 'retired',
      },
    });
    await signIn();
    expect(await db.user.findUniqueOrThrow({ where: { xId: profile.id } })).toMatchObject({
      role: 'CREATOR',
      approved: true,
      affiliation: 'retired',
    });
  });
  it.each(['new-creator', 'unapproved-old-fixture'])(
    'sandbox login ignores retired fixture prefixes: %s',
    async (id) => {
      const user = await sandboxUser(id);
      expect(user).toMatchObject({
        xId: `studio-test-${id}`,
        handle: 'test_creator',
        role: 'ADMIN',
        approved: false,
      });
      expect(await db.walletIdentity.count({ where: { userId: user.id } })).toBe(1);
      expect(await db.xAccount.count({ where: { userId: user.id } })).toBe(1);
    },
  );
});
