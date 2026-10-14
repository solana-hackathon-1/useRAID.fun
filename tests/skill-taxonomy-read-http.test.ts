import { expect, it, vi } from 'vitest';
import {
  createSkillTaxonomyReadHandler,
  SkillTaxonomyHttpError,
  type SkillTaxonomyReadHost,
} from '../src/skills/taxonomy-http';
const actor = { accountId: 'actual-admin', sessionHash: 'a'.repeat(64) };
const state = {
  version: 'v1',
  publisherAccountId: actor.accountId,
  taxonomyId: 'catalog',
  taxonomy: null,
  writesAvailable: false,
  unavailableReason: 'DISABLED',
};
function fixture(patch: Partial<SkillTaxonomyReadHost> = {}) {
  const host: SkillTaxonomyReadHost = {
    version: 'v1',
    actor: async () => actor,
    read: vi.fn(async () => state),
    requestId: () => 'read-request',
    ...patch,
  };
  return { host, api: createSkillTaxonomyReadHandler(host) };
}
it('returns bound private current publisher state even when new publication is off', async () => {
  const { api, host } = fixture();
  const r = await api.GET(new Request('https://raid.example'), Promise.resolve('catalog'));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual(state);
  expect(host.read).toHaveBeenCalledWith(actor, 'catalog');
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(r.headers.get('vary')).toBe('Cookie');
});
it.each([401, 403] as const)('denies current actor %i before read', async (status) => {
  const { api, host } = fixture({
    actor: async () => {
      throw new SkillTaxonomyHttpError(status);
    },
  });
  const r = await api.GET(new Request('https://raid.example'), 'catalog');
  expect(r.status).toBe(status);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(host.read).not.toHaveBeenCalled();
});
it('rejects invalid URL before consulting catalog storage', async () => {
  const { api, host } = fixture();
  const r = await api.GET(new Request('https://raid.example'), 'invalid/id');
  expect(r.status).toBe(422);
  expect(host.read).not.toHaveBeenCalled();
});
it.each(['publisher', 'catalog', 'availability', 'extra'])(
  'rejects unbound %s host state without exposing it',
  async (kind) => {
    const v = { ...state };
    if (kind === 'publisher') v.publisherAccountId = 'PRIVATE-SECRET';
    if (kind === 'catalog') v.taxonomyId = 'PRIVATE-SECRET';
    if (kind === 'availability') v.writesAvailable = true;
    if (kind === 'extra') Object.assign(v, { sessionHash: 'PRIVATE-SECRET' });
    const { api } = fixture({ read: async () => v });
    const r = await api.GET(new Request('https://raid.example'), 'catalog');
    expect(r.status).toBe(503);
    expect(r.headers.get('vary')).toBe('Cookie');
    expect(await r.text()).not.toContain('PRIVATE-SECRET');
  },
);
