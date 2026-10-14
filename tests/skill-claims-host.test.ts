import { afterEach, it, expect, vi } from 'vitest';
const storage = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), catalog: vi.fn(), port: {} }));
vi.mock('../src/skills/claim-storage', () => ({
  readSkillClaim: storage.read,
  saveSkillClaim: storage.save,
}));
vi.mock('../src/skills/taxonomy-storage', () => ({ readPublishedSkillTaxonomy: storage.catalog }));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  skillClaimWriteConfiguration,
  readSkillClaimState,
  readSkillCatalogState,
  saveSkillClaimFromHost,
} from '../src/lib/skill-claims-host';
const actor = { accountId: 'self', sessionHash: 'a'.repeat(64) };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults new claim writes off and rejects nonexact enablement values', () => {
  for (const value of ['', undefined, 'TRUE', '1', 'false']) {
    vi.stubEnv('SKILL_CLAIMS_ENABLED', value);
    expect(skillClaimWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('SKILL_CLAIMS_ENABLED', 'true');
  expect(skillClaimWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it('reads existing private claims and actual catalogs even with writes disabled', async () => {
  vi.stubEnv('SKILL_CLAIMS_ENABLED', 'false');
  storage.read.mockResolvedValue({ id: 'original' });
  storage.catalog.mockResolvedValue(null);
  expect(await readSkillClaimState(actor, 'frontend')).toEqual({
    version: 'v1',
    skillId: 'frontend',
    claim: { id: 'original' },
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  expect(storage.read).toHaveBeenCalledWith(storage.port, actor, 'frontend');
  expect(await readSkillCatalogState(actor, 'catalog')).toEqual({
    version: 'v1',
    taxonomyId: 'catalog',
    taxonomy: null,
  });
  expect(storage.catalog).toHaveBeenCalledWith(storage.port, actor, 'catalog');
});
it('delegates new-write gating to the SQL command so original authorized receipt replay remains possible', async () => {
  vi.stubEnv('SKILL_CLAIMS_ENABLED', 'false');
  const command = { actor, input: {}, idempotencyKey: 'original', requestId: 'r' };
  storage.save.mockResolvedValue({ status: 'REPLAYED', claim: { id: 'original' } });
  expect(await saveSkillClaimFromHost(command)).toEqual({
    version: 'v1',
    status: 'REPLAYED',
    claim: { id: 'original' },
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  expect(storage.save).toHaveBeenCalledWith(storage.port, command, { allowNewWrites: false });
});
