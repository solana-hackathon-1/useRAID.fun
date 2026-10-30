import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  create: vi.fn(),
  propose: vi.fn(),
  consent: vi.fn(),
  read: vi.fn(),
}));
vi.mock('../src/lib/command-receipts-adapter', () => ({ runCommandTransaction: mocks.run }));
vi.mock('../src/parties/party-storage', () => ({
  createParty: mocks.create,
  proposePartyRoster: mocks.propose,
  recordPartyMemberConsent: mocks.consent,
  readPartyProposal: mocks.read,
}));
import {
  createPartyFromHost,
  proposePartyRosterFromHost,
  readPartyProposalFromHost,
  recordPartyConsentFromHost,
} from '../src/lib/party-host';
import { config, partyRosterWritesEnabled } from '../src/lib/config';

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

it('is off unless the exact string true is set outside demo mode', () => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1', ' true']) {
    vi.stubEnv('PARTY_ROSTER_WRITES_ENABLED', flag as string);
    expect(partyRosterWritesEnabled()).toBe(false);
  }
  vi.stubEnv('PARTY_ROSTER_WRITES_ENABLED', 'true');
  expect(partyRosterWritesEnabled()).toBe(true);
  config.demo = true;
  expect(partyRosterWritesEnabled()).toBe(false);
});

it('passes the switch to every party write and leaves reads independent of it', async () => {
  const writes = [
    [createPartyFromHost, mocks.create],
    [proposePartyRosterFromHost, mocks.propose],
    [recordPartyConsentFromHost, mocks.consent],
  ] as const;
  for (const enabled of ['false', 'true']) {
    vi.stubEnv('PARTY_ROSTER_WRITES_ENABLED', enabled);
    for (const [write, storage] of writes) {
      await write(command);
      expect(storage).toHaveBeenLastCalledWith({}, command, { allowNewWrites: enabled === 'true' });
    }
  }
  vi.stubEnv('PARTY_ROSTER_WRITES_ENABLED', 'false');
  mocks.read.mockResolvedValue({ id: 'p' });
  expect(await readPartyProposalFromHost(actor, 'proposal-id')).toEqual({ id: 'p' });
  expect(mocks.read).toHaveBeenCalledWith({}, actor, { proposalId: 'proposal-id' });
});
