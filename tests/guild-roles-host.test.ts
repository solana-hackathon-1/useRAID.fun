import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  propose: vi.fn(),
  respond: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../src/lib/command-receipts-adapter', () => ({ runCommandTransaction: mocks.run }));
vi.mock('../src/guild-profiles/guild-storage', () => ({
  grantGuildRole: mocks.grant,
  revokeGuildRole: mocks.revoke,
  proposeOwnershipTransfer: mocks.propose,
  respondOwnershipTransfer: mocks.respond,
  listPendingOwnershipTransfers: mocks.list,
}));
import {
  grantRole,
  guildRolesWriteConfiguration,
  listTransfers,
  proposeTransfer,
  respondTransfer,
  revokeRole,
} from '../src/lib/guild-roles-host';
import { config } from '../src/lib/config';

const previousDemo = config.demo;
const actor = { accountId: 'self', sessionHash: 'a'.repeat(64) };
const command = { actor, input: {}, idempotencyKey: 'key', requestId: 'r' };
afterEach(() => {
  vi.unstubAllEnvs();
  config.demo = previousDemo;
});
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  config.demo = false;
  mocks.run.mockImplementation((_db, work) => work({}));
});

it('requires an exact explicit default-off non-demo switch and passes it to every new-write command', async () => {
  for (const flag of ['', 'false', 'TRUE', '1', ' true']) {
    vi.stubEnv('GUILD_ROLE_MANAGEMENT_ENABLED', flag);
    expect(guildRolesWriteConfiguration().writesAvailable).toBe(false);
  }
  await grantRole(command);
  await proposeTransfer(command);
  expect(mocks.grant).toHaveBeenLastCalledWith({}, command, { allowNewWrites: false });
  expect(mocks.propose).toHaveBeenLastCalledWith({}, command, { allowNewWrites: false });
  vi.stubEnv('GUILD_ROLE_MANAGEMENT_ENABLED', 'true');
  expect(guildRolesWriteConfiguration().writesAvailable).toBe(true);
  await grantRole(command);
  await proposeTransfer(command);
  expect(mocks.grant).toHaveBeenLastCalledWith({}, command, { allowNewWrites: true });
  expect(mocks.propose).toHaveBeenLastCalledWith({}, command, { allowNewWrites: true });
  config.demo = true;
  expect(guildRolesWriteConfiguration().writesAvailable).toBe(false);
});

it('hands revocation the switch too, but storage keeps revocation available while it is off', async () => {
  await revokeRole(command);
  expect(mocks.revoke).toHaveBeenLastCalledWith({}, command, { allowNewWrites: false });
});

it('answers the ownership policy hook closed: no project-control re-verification exists yet', async () => {
  vi.stubEnv('GUILD_ROLE_MANAGEMENT_ENABLED', 'true');
  await respondTransfer(command);
  const [, passed, ownershipHost] = mocks.respond.mock.calls[0];
  expect(passed).toBe(command);
  expect(ownershipHost.allowNewWrites).toBe(true);
  await expect(
    ownershipHost.authorizeOwnershipTransfer(
      {},
      { guildId: 'g', fromAccountId: 'a', toAccountId: 'b' },
    ),
  ).resolves.toBe(false);
});

it('reads pending transfers whatever the write switch says: a recipient can always see what is asked of them', async () => {
  mocks.list.mockResolvedValue({ transfers: [], truncated: false });
  for (const flag of [undefined, '', 'false', 'true']) {
    vi.stubEnv('GUILD_ROLE_MANAGEMENT_ENABLED', flag as string);
    expect(await listTransfers(actor)).toEqual({ version: 'v1', transfers: [], truncated: false });
  }
  config.demo = true;
  expect(await listTransfers(actor)).toEqual({ version: 'v1', transfers: [], truncated: false });
  // The read takes only the session actor, with no write policy at all.
  expect(mocks.list).toHaveBeenLastCalledWith({}, actor);
});
