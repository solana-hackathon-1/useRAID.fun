import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn(), save: vi.fn(), draft: vi.fn() }));
vi.mock('../src/lib/command-receipts-adapter', () => ({ runCommandTransaction: mocks.run }));
vi.mock('../src/guild-profiles/draft-storage', () => ({ readGuildDraft: mocks.draft }));
vi.mock('../src/guild-profiles/project-proposal-storage', () => ({
  readGuildProjectProposal: mocks.read,
  saveGuildProjectProposal: mocks.save,
}));
import {
  projectProposalWriteConfiguration,
  readProjectProposalState,
  saveProjectProposal,
  readProjectProposalPageState,
} from '../src/lib/project-proposal-host';
import { config } from '../src/lib/config';
const demo = config.demo;
const actor = { accountId: 'self', actorAccountId: 'self', sessionHash: 'a'.repeat(64) };
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  config.demo = false;
  mocks.run.mockImplementation((_db, work) => work({}));
});
afterEach(() => {
  vi.unstubAllEnvs();
  config.demo = demo;
});
it('requires both exact private-preparation flags in non-demo mode and delegates disabled writes for receipt replay', async () => {
  vi.stubEnv('GUILD_DRAFTS_ENABLED', 'true');
  for (const flag of ['', 'false', 'TRUE', '1']) {
    vi.stubEnv('GUILD_PROJECT_PROPOSALS_ENABLED', flag);
    expect(projectProposalWriteConfiguration().writesAvailable).toBe(false);
  }
  vi.stubEnv('GUILD_PROJECT_PROPOSALS_ENABLED', 'true');
  expect(projectProposalWriteConfiguration().writesAvailable).toBe(true);
  vi.stubEnv('GUILD_DRAFTS_ENABLED', 'false');
  expect(projectProposalWriteConfiguration().writesAvailable).toBe(false);
  vi.stubEnv('GUILD_DRAFTS_ENABLED', 'true');
  config.demo = true;
  expect(projectProposalWriteConfiguration().writesAvailable).toBe(false);
  config.demo = false;
  vi.stubEnv('GUILD_PROJECT_PROPOSALS_ENABLED', 'false');
  const proposal = { guildDraftId: id };
  mocks.save.mockResolvedValue({ status: 'REPLAYED', proposal });
  const command = { actor, input: {}, idempotencyKey: 'k', requestId: 'r' };
  expect(await saveProjectProposal(command)).toEqual({
    version: 'v1',
    guildDraftId: id,
    status: 'REPLAYED',
    proposal,
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  expect(mocks.save).toHaveBeenCalledWith({}, command, { allowNewWrites: false });
});
it('keeps authenticated own empty/current reads available while new writes are disabled', async () => {
  vi.stubEnv('GUILD_DRAFTS_ENABLED', 'false');
  vi.stubEnv('GUILD_PROJECT_PROPOSALS_ENABLED', 'false');
  for (const proposal of [null, { guildDraftId: id, revision: 2 }]) {
    mocks.read.mockResolvedValue(proposal);
    expect(await readProjectProposalState(actor, id)).toEqual({
      version: 'v1',
      guildDraftId: id,
      proposal,
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
    expect(mocks.read).toHaveBeenCalledWith({}, actor, id);
  }
});

it('loads current own draft and pending proposal in one guarded transaction without exposing actor/cookie props', async () => {
  vi.stubEnv('GUILD_DRAFTS_ENABLED', 'true');
  vi.stubEnv('GUILD_PROJECT_PROPOSALS_ENABLED', 'true');
  const draft = { id, revision: 3 },
    proposal = { guildDraftId: id, revision: 2 };
  mocks.draft.mockResolvedValue(draft);
  mocks.read.mockResolvedValue(proposal);
  expect(await readProjectProposalPageState(actor, id)).toEqual({
    draft,
    state: {
      version: 'v1',
      guildDraftId: id,
      proposal,
      writesAvailable: true,
      unavailableReason: null,
    },
  });
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(mocks.draft).toHaveBeenCalledWith({}, actor, id);
  expect(mocks.read).toHaveBeenCalledWith({}, actor, id);
});
