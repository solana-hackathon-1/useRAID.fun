import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock('../src/lib/command-receipts-adapter', () => ({ runCommandTransaction: mocks.run }));
vi.mock('../src/raider-onboarding/storage', () => ({
  readRaiderOrientation: mocks.read,
  saveRaiderOrientation: mocks.save,
}));
import {
  orientationCatalog,
  orientationWriteConfiguration,
  readOrientationState,
  saveOrientation,
} from '../src/lib/raider-onboarding-host';
import { OrientationStorageError } from '../src/raider-onboarding/storage-contracts';
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
it('requires exact default-off flag and a valid explicit host catalog for new writes', async () => {
  vi.stubEnv('RAIDER_ONBOARDING_ENABLED', 'false');
  vi.stubEnv('RAIDER_ONBOARDING_CATALOG', '[{"id":"qa","label":"QA"}]');
  expect(orientationWriteConfiguration().writesAvailable).toBe(false);
  mocks.save.mockRejectedValue(new OrientationStorageError('WRITES_DISABLED'));
  await expect(
    saveOrientation({ actor, input: {}, idempotencyKey: 'key', requestId: 'r' }),
  ).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
  expect(mocks.save).toHaveBeenCalledWith({}, expect.any(Object), expect.any(Object), {
    allowNewWrites: false,
  });
  vi.stubEnv('RAIDER_ONBOARDING_ENABLED', 'true');
  expect(orientationWriteConfiguration().writesAvailable).toBe(true);
  config.demo = true;
  expect(orientationWriteConfiguration().writesAvailable).toBe(false);
});
it.each([
  '',
  'invalid',
  '[]',
  '[{"id":"qa","label":"QA"},{"id":"qa","label":"Other"}]',
  '[{"id":"qa","label":"QA","rank":"S"}]',
])('fails closed on invalid catalog %j while preserving owned reads', async (raw) => {
  vi.stubEnv('RAIDER_ONBOARDING_ENABLED', 'true');
  vi.stubEnv('RAIDER_ONBOARDING_CATALOG', raw);
  expect(orientationCatalog()).toEqual([]);
  const state = await readOrientationState(actor);
  expect(state.orientation).toEqual({ revision: 2 });
  expect(state.writesAvailable).toBe(false);
  expect(mocks.read).toHaveBeenCalledWith({}, actor);
});
