import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  read: vi.fn(),
  edit: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../src/lib/command-receipts-adapter', () => ({ runCommandTransaction: mocks.run }));
vi.mock('../src/guild-profiles/guild-storage', () => ({
  readManagedGuild: mocks.read,
  editGuildProfile: mocks.edit,
  listManagedGuilds: mocks.list,
}));
import {
  editProfile,
  guildProfileWriteConfiguration,
  listManagedGuildsState,
  readProfileState,
} from '../src/lib/guild-profile-host';
import { config } from '../src/lib/config';
const previousDemo = config.demo;
const guildId = '11111111-1111-4111-8111-111111111111';
const actor = { accountId: 'self', sessionHash: 'a'.repeat(64) };
afterEach(() => {
  vi.unstubAllEnvs();
  config.demo = previousDemo;
});
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  config.demo = false;
  mocks.run.mockImplementation((_db, work) => work({}));
  mocks.read.mockResolvedValue({ guild: { revision: 2 }, authority: { founder: true, kinds: [] } });
});
it('requires an exact explicit default-off non-demo switch and passes it to the edit command', async () => {
  for (const flag of ['', 'false', 'TRUE', '1']) {
    vi.stubEnv('GUILD_PROFILE_EDITS_ENABLED', flag);
    expect(guildProfileWriteConfiguration().writesAvailable).toBe(false);
  }
  await editProfile({ actor, input: {}, idempotencyKey: 'key', requestId: 'r' });
  expect(mocks.edit).toHaveBeenCalledWith({}, expect.any(Object), { allowNewWrites: false });
  vi.stubEnv('GUILD_PROFILE_EDITS_ENABLED', 'true');
  expect(guildProfileWriteConfiguration().writesAvailable).toBe(true);
  await editProfile({ actor, input: {}, idempotencyKey: 'key', requestId: 'r' });
  expect(mocks.edit).toHaveBeenLastCalledWith({}, expect.any(Object), { allowNewWrites: true });
  config.demo = true;
  expect(guildProfileWriteConfiguration().writesAvailable).toBe(false);
});
it('keeps the caller’s own read available while edits are disabled', async () => {
  vi.stubEnv('GUILD_PROFILE_EDITS_ENABLED', 'false');
  expect(await readProfileState(actor, guildId)).toEqual({
    version: 'v1',
    guild: { revision: 2 },
    authority: { founder: true, kinds: [] },
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  expect(mocks.read).toHaveBeenCalledWith({}, actor, guildId);
});
it('lists the caller’s own managed Guilds through the guarded transaction, with no flag needed and the profile-edit state attached', async () => {
  vi.stubEnv('GUILD_PROFILE_EDITS_ENABLED', 'false');
  const guilds = [{ guild: { slug: 'g' }, authority: { founder: true, kinds: ['PROFILE'] } }];
  mocks.list.mockResolvedValue({ guilds });
  expect(await listManagedGuildsState(actor)).toEqual({
    version: 'v1',
    guilds,
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  vi.stubEnv('GUILD_PROFILE_EDITS_ENABLED', 'true');
  expect(await listManagedGuildsState(actor)).toMatchObject({
    writesAvailable: true,
    unavailableReason: null,
  });
  expect(mocks.list).toHaveBeenCalledWith({}, actor);
  expect(mocks.edit).not.toHaveBeenCalled();
});
