import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn(), save: vi.fn(), list: vi.fn() }));
vi.mock('../src/lib/command-receipts-adapter', () => ({ runCommandTransaction: mocks.run }));
vi.mock('../src/guild-profiles/draft-storage', () => ({
  readGuildDraft: mocks.read,
  saveGuildDraft: mocks.save,
  listGuildDrafts: mocks.list,
}));
import {
  guildDraftWriteConfiguration,
  readGuildDraftState,
  saveDraft,
  readGuildDraftIndexState,
} from '../src/lib/guild-draft-host';
import { config } from '../src/lib/config';
const previousDemo = config.demo;
afterEach(() => {
  vi.unstubAllEnvs();
  config.demo = previousDemo;
});
const actor = { accountId: 'self', actorAccountId: 'self', sessionHash: 'a'.repeat(64) };
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  config.demo = false;
  mocks.run.mockImplementation((_db, work) => work({}));
  mocks.read.mockResolvedValue({ revision: 2 });
});
it('requires an exact explicit default-off non-demo write switch and passes it to the storage command without blocking replay', async () => {
  for (const flag of ['', 'false', 'TRUE', '1']) {
    vi.stubEnv('GUILD_DRAFTS_ENABLED', flag);
    expect(guildDraftWriteConfiguration().writesAvailable).toBe(false);
  }
  await saveDraft({ actor, input: {}, idempotencyKey: 'key', requestId: 'r' });
  expect(mocks.save).toHaveBeenCalledWith({}, expect.any(Object), { allowNewWrites: false });
  vi.stubEnv('GUILD_DRAFTS_ENABLED', 'true');
  expect(guildDraftWriteConfiguration().writesAvailable).toBe(true);
  config.demo = true;
  expect(guildDraftWriteConfiguration().writesAvailable).toBe(false);
});
it('keeps owned read and write configuration independent when creation is disabled', async () => {
  vi.stubEnv('GUILD_DRAFTS_ENABLED', 'false');
  const state = await readGuildDraftState(actor, '11111111-1111-4111-8111-111111111111');
  expect(state.draft).toEqual({ revision: 2 });
  expect(state.writesAvailable).toBe(false);
  expect(mocks.read).toHaveBeenCalledWith({}, actor, '11111111-1111-4111-8111-111111111111');
});
it('passes only current own actor and bounded input to listing while new writes are disabled', async () => {
  vi.stubEnv('GUILD_DRAFTS_ENABLED', 'false');
  const page = { version: 'v1', drafts: [], nextCursor: null };
  mocks.list.mockResolvedValue(page);
  const input = { cursor: null, pageSize: 20 };
  expect(await readGuildDraftIndexState(actor, input)).toEqual({
    version: 'v1',
    page,
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  expect(mocks.list).toHaveBeenCalledWith({}, actor, input);
});
