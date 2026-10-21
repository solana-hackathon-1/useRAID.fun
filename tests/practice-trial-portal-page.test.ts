import { beforeEach, describe, expect, it, vi } from 'vitest';
import { definition } from '../examples/skill-assessments/fixtures';
const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  cookie: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  reads: vi.fn(),
  start: vi.fn(),
  submit: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock('../src/lib/auth', async (original) => ({
  ...(await original<typeof import('../src/lib/auth')>()),
  currentUser: mocks.user,
}));
vi.mock('../src/lib/practice-portal-host', () => ({
  listPracticeTrialsFromHost: mocks.list,
  readPracticeProgressFromHost: mocks.read,
  practicePortalReadConfiguration: mocks.reads,
  practiceStartConfiguration: mocks.start,
  practiceSubmitConfiguration: mocks.submit,
}));
import { loadPracticeCatalog, loadPracticeWorkspace } from '../src/lib/practice-portal-page';
import { hash } from '../src/lib/auth-primitives';

const startId = '44444444-4444-4444-8444-444444444444';
const catalog = { version: 'v1', taxonomyId: 'catalog', trials: [], nextCursor: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: 'synthetic-self' });
  mocks.cookie.mockReturnValue({ value: 'synthetic-cookie' });
  mocks.reads.mockReturnValue({ readsAvailable: true, unavailableReason: null });
  mocks.start.mockReturnValue({ writesAvailable: true, unavailableReason: null });
  mocks.submit.mockReturnValue({ writesAvailable: false, unavailableReason: 'DISABLED' });
  mocks.list.mockResolvedValue(catalog);
});

describe('loadPracticeCatalog', () => {
  it('requires a signed-in session cookie and never calls the host without one', async () => {
    mocks.user.mockResolvedValue(null);
    expect(await loadPracticeCatalog()).toEqual({ status: 'SIGN_IN' });
    mocks.user.mockResolvedValue({ id: 'u' });
    mocks.cookie.mockReturnValue(undefined);
    expect(await loadPracticeCatalog()).toEqual({ status: 'SIGN_IN' });
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('reads the first page as the current session and reports write availability', async () => {
    const out = await loadPracticeCatalog();
    expect(out).toEqual({
      status: 'READY',
      catalog,
      writesAvailable: true,
    });
    expect(mocks.list).toHaveBeenCalledWith(
      { accountId: 'synthetic-self', sessionHash: hash('synthetic-cookie') },
      null,
    );
  });
  it('does not read when disabled and degrades to unavailable on host failure without detail', async () => {
    mocks.reads.mockReturnValue({ readsAvailable: false, unavailableReason: 'DISABLED' });
    expect(await loadPracticeCatalog()).toEqual({ status: 'UNAVAILABLE' });
    expect(mocks.list).not.toHaveBeenCalled();
    mocks.reads.mockReturnValue({ readsAvailable: true, unavailableReason: null });
    mocks.list.mockRejectedValue(new Error('SQL secret detail'));
    expect(await loadPracticeCatalog()).toEqual({ status: 'UNAVAILABLE' });
  });
});

describe('loadPracticeWorkspace', () => {
  const progress = { version: 'v1', progress: 'STARTED', start: { id: startId }, submission: null };
  it('rejects a malformed start id before any read', async () => {
    expect(await loadPracticeWorkspace('../nope')).toEqual({ status: 'NOT_FOUND' });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('maps own-only absence to NOT_FOUND and other failures to UNAVAILABLE', async () => {
    mocks.read.mockResolvedValue(null);
    expect(await loadPracticeWorkspace(startId)).toEqual({ status: 'NOT_FOUND' });
    mocks.read.mockRejectedValue(new Error('driver detail'));
    expect(await loadPracticeWorkspace(startId)).toEqual({ status: 'UNAVAILABLE' });
  });
  it('returns the saved progress and submit availability for the current session', async () => {
    mocks.read.mockResolvedValue(progress);
    expect(await loadPracticeWorkspace(startId)).toEqual({
      status: 'READY',
      progress,
      writesAvailable: false,
    });
    expect(mocks.read).toHaveBeenCalledWith(
      { accountId: 'synthetic-self', sessionHash: hash('synthetic-cookie') },
      startId,
    );
    expect(definition.title).toBeTruthy();
  });
  it('requires sign-in first', async () => {
    mocks.user.mockResolvedValue(null);
    expect(await loadPracticeWorkspace(startId)).toEqual({ status: 'SIGN_IN' });
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
