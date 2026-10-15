import { beforeEach, expect, it, vi } from 'vitest';
import {
  createOwnSkillAssessmentHandlers,
  OwnSkillAssessmentHttpError,
} from '../src/skills/own-assessment-http';
const actor = { accountId: 'owner', sessionHash: 'a'.repeat(64) };
const view = {
  version: 'v1',
  private: true,
  skillId: 'frontend',
  skillDomain: 'web',
  skillName: 'Frontend',
  taxonomyReference: { recordId: 'catalog', revision: 1 },
  assessmentReference: null,
  recordedState: null,
  effectiveStatus: 'NO_ASSESSMENT',
  assessedRank: null,
  issuedAt: null,
  reassessmentAt: null,
  reasonCategory: null,
  observedAt: '2026-10-15T00:00:00.000Z',
  informational: true,
  isAuthorizationToken: false,
  createsPermissionGrant: false,
  consumesCapacity: false,
  createsFinancialObligation: false,
};
const host = {
  version: 'v1' as const,
  actor: vi.fn(),
  rateLimit: vi.fn(),
  read: vi.fn(),
  requestId: () => 'request',
};
beforeEach(() => {
  vi.clearAllMocks();
  host.actor.mockResolvedValue(actor);
  host.rateLimit.mockResolvedValue(undefined);
  host.read.mockResolvedValue({
    version: 'v1',
    view,
    readsAvailable: true,
    unavailableReason: null,
  });
});
const get = (id: string | Promise<string> = 'frontend') =>
  createOwnSkillAssessmentHandlers(host).GET(
    new Request('http://localhost/api/v1/skill-assessments/frontend'),
    id,
  );
function privacy(r: Response) {
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(r.headers.get('vary')).toContain('Cookie');
}
it('returns only validated own summary with no-store and binds actual authenticated actor/path', async () => {
  const r = await get(Promise.resolve('frontend'));
  privacy(r);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({
    version: 'v1',
    view,
    readsAvailable: true,
    unavailableReason: null,
  });
  expect(host.read).toHaveBeenCalledWith(actor, 'frontend');
  expect(host.rateLimit).toHaveBeenCalledWith(actor);
});
it.each([401, 403, 429] as const)(
  'sanitizes authority denial %s before source access with private headers',
  async (status) => {
    host.actor.mockRejectedValue(new OwnSkillAssessmentHttpError(status));
    const r = await get();
    privacy(r);
    expect(r.status).toBe(status);
    expect(host.read).not.toHaveBeenCalled();
    expect(JSON.stringify(await r.json())).not.toContain('sessionHash');
  },
);
it('validates malformed path after authority and before source', async () => {
  const r = await get('<script>');
  privacy(r);
  expect(r.status).toBe(422);
  expect(host.read).not.toHaveBeenCalled();
  expect(host.actor).toHaveBeenCalled();
});
it('denies rate limit before source', async () => {
  host.rateLimit.mockRejectedValue(new OwnSkillAssessmentHttpError(429));
  const r = await get();
  privacy(r);
  expect(r.status).toBe(429);
  expect(host.read).not.toHaveBeenCalled();
});
it.each([
  { ...view, skillId: 'other' },
  { ...view, answer: 'private-code-marker' },
  { ...view, effectiveStatus: 'VERIFIED' },
  { ...view, reason: 'private-case-marker' },
])(
  'fails closed for incoherent or excessive host output without leaking fields %j',
  async (bad) => {
    host.read.mockResolvedValue({
      version: 'v1',
      view: bad,
      readsAvailable: true,
      unavailableReason: null,
    });
    const r = await get();
    privacy(r);
    expect(r.status).toBe(503);
    const body = JSON.stringify(await r.json());
    expect(body).not.toContain('private-');
    expect(body).not.toContain('sessionHash');
  },
);
it('unavailable/disabled output carries no stale private view', async () => {
  host.read.mockResolvedValue({
    version: 'v1',
    view: null,
    readsAvailable: false,
    unavailableReason: 'DISABLED',
  });
  const r = await get();
  privacy(r);
  expect(r.status).toBe(503);
});
it('missing canonical skill source returns generic not-found without private diagnostics', async () => {
  host.read.mockResolvedValue({
    version: 'v1',
    view: null,
    readsAvailable: true,
    unavailableReason: null,
  });
  const r = await get();
  privacy(r);
  expect(r.status).toBe(404);
});
it('sanitizes host exceptions', async () => {
  host.read.mockRejectedValue(Error('private-driver-marker'));
  const r = await get();
  privacy(r);
  expect(r.status).toBe(503);
  expect(JSON.stringify(await r.json())).not.toContain('private-driver-marker');
});
