import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), activate: vi.fn() }));
vi.mock('../src/lib/command-receipts-adapter', () => ({ runCommandTransaction: mocks.run }));
vi.mock('../src/guild-profiles/guild-storage', () => ({ activateGuild: mocks.activate }));
import {
  activateGuildAsOperator,
  guildActivationConfiguration,
} from '../src/lib/guild-activation-host';
import { config } from '../src/lib/config';

const previousDemo = config.demo;
const actor = { accountId: 'operator-1', sessionHash: 'a'.repeat(64) };
const command = { actor, input: {}, idempotencyKey: 'key', requestId: 'r' };
const askHost = async (accountId: string) => {
  await activateGuildAsOperator(command);
  const [, passed, host] = mocks.activate.mock.calls.at(-1)!;
  expect(passed).toBe(command);
  return host.authorizeActivation({}, { accountId }) as Promise<boolean>;
};
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  config.demo = false;
  mocks.run.mockImplementation((_db, work) => work({}));
});
afterEach(() => {
  vi.unstubAllEnvs();
  config.demo = previousDemo;
});

it('requires an exact explicit default-off non-demo switch and passes it as allowNewWrites', async () => {
  expect(guildActivationConfiguration()).toEqual({
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  for (const flag of ['', 'false', 'TRUE', '1', ' true']) {
    vi.stubEnv('GUILD_ACTIVATION_ENABLED', flag);
    expect(guildActivationConfiguration().writesAvailable).toBe(false);
  }
  await activateGuildAsOperator(command);
  expect(mocks.activate.mock.calls.at(-1)![2].allowNewWrites).toBe(false);
  vi.stubEnv('GUILD_ACTIVATION_ENABLED', 'true');
  expect(guildActivationConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
  await activateGuildAsOperator(command);
  expect(mocks.activate.mock.calls.at(-1)![2].allowNewWrites).toBe(true);
  config.demo = true;
  expect(guildActivationConfiguration().writesAvailable).toBe(false);
});

it('approves only accounts on the dedicated GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS allowlist', async () => {
  vi.stubEnv('GUILD_ACTIVATION_ENABLED', 'true');
  // Unset and blank: nobody.
  expect(await askHost('operator-1')).toBe(false);
  vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', '  , ,');
  expect(await askHost('operator-1')).toBe(false);
  expect(await askHost('')).toBe(false);
  vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', ' operator-1 , operator-2 ,,');
  expect(await askHost('operator-1')).toBe(true);
  expect(await askHost('operator-2')).toBe(true);
  // Exact match only: no case folding, no prefix or substring match.
  expect(await askHost('Operator-1')).toBe(false);
  expect(await askHost('operator')).toBe(false);
  expect(await askHost('operator-1,operator-2')).toBe(false);
  expect(await askHost('operator-3')).toBe(false);
});

it('never reuses the work operator allowlist or any other list as activation authority', async () => {
  vi.stubEnv('GUILD_ACTIVATION_ENABLED', 'true');
  vi.stubEnv('RAID_WORK_OPERATOR_ACCOUNT_IDS', 'operator-1');
  vi.stubEnv('ADMIN_ACCOUNT_IDS', 'operator-1');
  vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', 'someone-else');
  expect(await askHost('operator-1')).toBe(false);
});

it('keeps the allowlist answer independent of the switch so an original receipt can still be replayed', async () => {
  vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', 'operator-1');
  expect(await askHost('operator-1')).toBe(true);
  expect(mocks.activate.mock.calls.at(-1)![2].allowNewWrites).toBe(false);
});

const REAL_FUNDS_FLAGS = [
  'LAUNCH_ENABLED',
  'PAYOUT_ENABLED',
  'X_TRACKING_V2_SETTLEMENT_ENABLED',
  'LIVE_COLLECTION_APPROVED',
];
it.each(REAL_FUNDS_FLAGS)(
  'fails closed for an allowlisted operator while %s is enabled: simulated funds only',
  async (flag) => {
    vi.stubEnv('GUILD_ACTIVATION_ENABLED', 'true');
    vi.stubEnv('GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS', 'operator-1');
    expect(await askHost('operator-1')).toBe(true);
    vi.stubEnv(flag, 'true');
    expect(await askHost('operator-1')).toBe(false);
    expect(guildActivationConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
    expect(mocks.activate.mock.calls.at(-1)![2].allowNewWrites).toBe(false);
    // Same truthiness as the flags themselves: only the exact string `true` turns one on.
    for (const value of ['', 'false', 'TRUE', '1', ' true']) {
      vi.stubEnv(flag, value);
      expect(await askHost('operator-1'), `${flag}=${JSON.stringify(value)}`).toBe(true);
    }
  },
);
