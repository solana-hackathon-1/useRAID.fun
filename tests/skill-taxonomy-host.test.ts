import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ publish: vi.fn(), port: {} }));
vi.mock('../src/skills/taxonomy-storage', () => ({ publishSkillTaxonomy: storage.publish }));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  publishSkillTaxonomyFromHost,
  skillTaxonomyWriteConfiguration,
} from '../src/lib/skill-taxonomy-host';
const command = {
  actor: { accountId: 'self', sessionHash: 'a'.repeat(64) },
  input: {},
  idempotencyKey: 'original',
  requestId: 'r',
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults new taxonomy publication off and accepts only exact true', () => {
  for (const v of [undefined, '', 'false', 'TRUE', '1']) {
    vi.stubEnv('SKILL_TAXONOMY_PUBLICATION_ENABLED', v);
    expect(skillTaxonomyWriteConfiguration()).toEqual({
      writesAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('SKILL_TAXONOMY_PUBLICATION_ENABLED', 'true');
  expect(skillTaxonomyWriteConfiguration()).toEqual({
    writesAvailable: true,
    unavailableReason: null,
  });
});
it('delegates disabled new-write policy to SQL while retaining original replay', async () => {
  vi.stubEnv('SKILL_TAXONOMY_PUBLICATION_ENABLED', 'false');
  storage.publish.mockResolvedValue({ status: 'REPLAYED', taxonomy: { id: 'original' } });
  expect(await publishSkillTaxonomyFromHost(command)).toEqual({
    version: 'v1',
    status: 'REPLAYED',
    taxonomy: { id: 'original' },
    writesAvailable: false,
    unavailableReason: 'DISABLED',
  });
  expect(storage.publish).toHaveBeenCalledWith(storage.port, command, {
    allowNewWrites: false,
    canPublish: expect.any(Function),
  });
});
it('reevaluates actual allowlist from locked DB facts on every invocation and rejects Studio-only privilege', async () => {
  vi.stubEnv('X_ADMIN_USER_ID', ' actual-x ');
  vi.stubEnv('ADMIN_X_IDS', ' another-x, third-x ');
  storage.publish.mockImplementation(async (_tx, _command, options) => {
    const locked = { accountId: 'self', xId: 'actual-x' };
    expect(options.canPublish(locked)).toBe(true);
    expect(options.canPublish({ ...locked, xId: 'another-x' })).toBe(true);
    expect(options.canPublish({ ...locked, xId: 'studio-unlisted' })).toBe(false);
    vi.stubEnv('X_ADMIN_USER_ID', '');
    expect(options.canPublish(locked)).toBe(false);
    vi.stubEnv('ADMIN_X_IDS', '');
    expect(options.canPublish({ ...locked, xId: 'another-x' })).toBe(false);
    return { status: 'REPLAYED', taxonomy: {} };
  });
  await publishSkillTaxonomyFromHost(command);
});
