import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../src/lib/db';
import { config } from '../src/lib/config';
import { hash } from '../src/lib/auth';
import { startAttempt, claimAttempt, completeConnection, disconnectX } from '../src/lib/x-oauth';
const integration = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
integration('X connection PostgreSQL invariants', () => {
  const profile = { id: '123456789', username: 'alice', name: 'Alice' };
  beforeAll(() => {
    if (new URL(process.env.DATABASE_URL || 'http://invalid').pathname !== '/useraid_test')
      throw Error('Use a dedicated useraid_test database.');
    config.demo = false;
    config.appUrl = 'http://localhost:3000';
    vi.stubEnv('X_CLIENT_ID', 'fixture-client');
    vi.stubEnv('X_CLIENT_SECRET', 'fixture-secret');
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE "User", "OAuthAttempt", "Token" CASCADE');
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$disconnect();
  });
  async function connect(sessionHash: string | null = null, identity = profile) {
    const { state } = await startAttempt(sessionHash);
    const attempt = await claimAttempt(state, sessionHash);
    return completeConnection(attempt, identity);
  }
  it('creates identity metadata and updates changed username without changing ownership', async () => {
    await connect();
    const original = await db.xAccount.findUniqueOrThrow({ where: { xUserId: profile.id } });
    await connect(null, { ...profile, username: 'renamed' });
    const changed = await db.xAccount.findUniqueOrThrow({ where: { xUserId: profile.id } });
    expect(changed.userId).toBe(original.userId);
    expect(changed.connectedAt).toEqual(original.connectedAt);
    expect(changed.username).toBe('renamed');
    expect(await db.user.count()).toBe(1);
  });
  it('only one callback can claim a state and session binding cannot be changed', async () => {
    const token = await connect();
    const { state } = await startAttempt(hash(token));
    await expect(claimAttempt(state, null)).rejects.toMatchObject({ code: 'state' });
    const results = await Promise.allSettled([
      claimAttempt(state, hash(token)),
      claimAttempt(state, hash(token)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('rejects expired state', async () => {
    const { state } = await startAttempt(null);
    await db.oAuthAttempt.update({
      where: { stateHash: hash(state) },
      data: { expiresAt: new Date(0) },
    });
    await expect(claimAttempt(state, null)).rejects.toMatchObject({ code: 'state' });
  });
  it('serializes duplicate account creation', async () => {
    const results = await Promise.allSettled([connect(), connect()]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await db.user.count()).toBe(1);
    expect(await db.xAccount.count()).toBe(1);
  });
  it('rejects a different identity for a signed-in user', async () => {
    const token = await connect();
    await expect(connect(hash(token), { ...profile, id: '999' })).rejects.toMatchObject({
      code: 'identity',
    });
    expect(await db.user.count()).toBe(1);
    expect((await db.xAccount.findFirstOrThrow()).xUserId).toBe(profile.id);
  });
  it('rejects an X connection owned by another user', async () => {
    const owner = await db.user.create({ data: { xId: '999', handle: 'owner' } });
    await db.xAccount.create({
      data: { userId: owner.id, xUserId: profile.id, username: 'alice', displayName: 'Alice' },
    });
    await expect(connect()).rejects.toMatchObject({ code: 'identity' });
    expect(await db.user.count()).toBe(1);
    expect((await db.xAccount.findFirstOrThrow()).userId).toBe(owner.id);
  });
  it('disconnect preserves sessions, user, and raids and cancels a claimed callback', async () => {
    const token = await connect();
    const user = await db.user.findUniqueOrThrow({ where: { xId: profile.id } });
    const raid = await db.raid.create({
      data: {
        tag: 'OAUTH_TEST',
        title: 'History',
        description: 'Preserve me',
        creator: { connect: { id: user.id } },
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3600000),
        token: { create: { mint: 'oauth-test-mint', symbol: 'TEST', name: 'Test' } },
      },
    });
    const { state } = await startAttempt(hash(token));
    const claimed = await claimAttempt(state, hash(token));
    await disconnectX(user.id);
    await expect(completeConnection(claimed, profile)).rejects.toMatchObject({ code: 'state' });
    expect(await db.xAccount.count()).toBe(0);
    expect(await db.session.findUnique({ where: { tokenHash: hash(token) } })).not.toBeNull();
    expect(await db.raid.findUnique({ where: { id: raid.id } })).not.toBeNull();
    await connect(null);
    expect((await db.xAccount.findFirstOrThrow()).userId).toBe(user.id);
  });
  it('disconnect and callback race always ends disconnected', async () => {
    const token = await connect();
    const user = await db.user.findUniqueOrThrow({ where: { xId: profile.id } });
    const { state } = await startAttempt(hash(token));
    const claimed = await claimAttempt(state, hash(token));
    const results = await Promise.allSettled([
      completeConnection(claimed, profile),
      disconnectX(user.id),
    ]);
    expect(results[1].status).toBe('fulfilled');
    expect(await db.xAccount.count()).toBe(0);
  });
  it('rejects a session removed during authorization', async () => {
    const token = await connect();
    const { state } = await startAttempt(hash(token));
    const attempt = await claimAttempt(state, hash(token));
    await db.session.delete({ where: { tokenHash: hash(token) } });
    await expect(completeConnection(attempt, profile)).rejects.toMatchObject({ code: 'session' });
  });
  it('suspended accounts cannot sign in and admin ID uses existing role', async () => {
    vi.stubEnv('X_ADMIN_USER_ID', profile.id);
    await connect();
    const user = await db.user.findUniqueOrThrow({ where: { xId: profile.id } });
    expect(user).toMatchObject({ role: 'ADMIN', approved: true });
    await db.user.update({ where: { id: user.id }, data: { suspended: true } });
    await expect(connect()).rejects.toMatchObject({ code: 'suspended' });
  });
});
