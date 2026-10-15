import { afterEach, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ read: vi.fn(), port: {} }));
vi.mock('../src/skills/own-assessment-storage', () => ({ readOwnSkillAssessment: storage.read }));
vi.mock('../src/lib/db', () => ({ db: {} }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: vi.fn(async (_db, work) => work(storage.port)),
}));
import {
  ownSkillAssessmentReadConfiguration,
  readOwnSkillAssessmentFromHost,
} from '../src/lib/own-skill-assessments-host';
const actor = { accountId: 'owner', sessionHash: 'a'.repeat(64) };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it('defaults reads off and requires explicit valid assessment namespace', () => {
  for (const value of [undefined, '', 'TRUE', 'false', '1']) {
    vi.stubEnv('SKILL_ASSESSMENT_READS_ENABLED', value);
    expect(ownSkillAssessmentReadConfiguration()).toMatchObject({
      readsAvailable: false,
      unavailableReason: 'DISABLED',
    });
  }
  vi.stubEnv('SKILL_ASSESSMENT_READS_ENABLED', 'true');
  for (const id of [undefined, '', ' bad ', '<script>']) {
    vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', id);
    expect(ownSkillAssessmentReadConfiguration()).toMatchObject({
      readsAvailable: false,
      unavailableReason: 'MISCONFIGURED',
    });
  }
});
it('composes actual own observation/current namespace but sends only the bounded summary after COMMIT', async () => {
  vi.stubEnv('SKILL_ASSESSMENT_READS_ENABLED', 'true');
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'catalog');
  const view = { private: true };
  storage.read.mockResolvedValue({
    view,
    evidence: { private: 'internal-evaluator-id' },
    taxonomy: { private: 'catalog' },
    accessId: 'private-access',
  });
  const r = await readOwnSkillAssessmentFromHost(actor, 'frontend');
  expect(r).toEqual({ version: 'v1', view, readsAvailable: true, unavailableReason: null });
  const [port, a, input, canRead] = storage.read.mock.calls[0];
  expect(port).toBe(storage.port);
  expect(a).toBe(actor);
  expect(input).toEqual({ version: 'v1', taxonomyId: 'catalog', skillId: 'frontend' });
  expect(canRead({ taxonomyId: 'catalog' })).toBe(true);
  expect(canRead({ taxonomyId: 'other' })).toBe(false);
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'other');
  expect(canRead({ taxonomyId: 'catalog' })).toBe(false);
});
it('drops private delivery if read configuration closes after committed audit', async () => {
  vi.stubEnv('SKILL_ASSESSMENT_READS_ENABLED', 'true');
  vi.stubEnv('PRACTICE_ASSESSMENT_CATALOG_ID', 'catalog');
  storage.read.mockImplementation(async () => {
    vi.stubEnv('SKILL_ASSESSMENT_READS_ENABLED', 'false');
    return { view: { private: true } };
  });
  expect(await readOwnSkillAssessmentFromHost(actor, 'frontend')).toEqual({
    version: 'v1',
    view: null,
    readsAvailable: false,
    unavailableReason: 'DISABLED',
  });
});
it('does not load private source while disabled', async () => {
  expect(await readOwnSkillAssessmentFromHost(actor, 'frontend')).toMatchObject({
    view: null,
    readsAvailable: false,
  });
  expect(storage.read).not.toHaveBeenCalled();
});
