import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createSkillAppealHandlers,
  SkillAppealHttpAuthorityError,
} from '../src/skill-appeals/http';
import { SkillAppealError } from '../src/skill-appeals/contracts';

const actor = { accountId: 'synthetic-account', sessionHash: 'a'.repeat(64) };
const appealId = randomUUID();
const assessmentId = randomUUID();
const view = (state: 'PENDING' | 'UPHELD' | 'DENIED' = 'PENDING') => ({
  version: 'v1',
  id: appealId,
  assessmentReference: { recordId: assessmentId, revision: 1 },
  skillId: 'frontend',
  reasonCategory: 'FACTUAL_ERROR',
  state,
  filedAt: '2026-11-14T00:00:00.000Z',
  adjudicationDueAt: '2026-11-28T00:00:00.000Z',
  decidedAt: state === 'PENDING' ? null : '2026-11-15T00:00:00.000Z',
  freshReview: { required: state === 'UPHELD', excludesOriginalReviewers: state === 'UPHELD' },
  changesAssessment: false,
  grantsRank: false,
  isAuthorizationToken: false,
});
function host(overrides: Record<string, unknown> = {}) {
  return {
    version: 'v1' as const,
    requestId: () => randomUUID(),
    actor: async () => actor,
    checkOrigin: vi.fn(),
    rateLimit: vi.fn(),
    file: vi.fn(async () => ({ status: 'EXECUTED', appeal: view() })),
    adjudicate: vi.fn(async () => ({ status: 'EXECUTED', appeal: view('UPHELD') })),
    ...overrides,
  };
}
const post = (body: unknown, headers: Record<string, string> = {}, url = 'http://t/x') =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1', ...headers },
    body: JSON.stringify(body),
  });
const fileBody = {
  version: 'v1',
  expectedAssessmentReference: { recordId: assessmentId, revision: 1 },
  reasonCategory: 'FACTUAL_ERROR',
  statement: 'Synthetic statement.',
};
const decisionBody = { version: 'v1', outcome: 'UPHELD', reason: 'Synthetic reason.' };

describe('skill-assessment appeal transport', () => {
  it('refuses a host missing a required function', () => {
    expect(() => createSkillAppealHandlers({ ...host(), file: undefined } as never)).toThrow();
  });
  it('files with the session actor and a private no-store response', async () => {
    const h = host();
    const res = await createSkillAppealHandlers(h).FILE(post(fileBody));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ status: 'EXECUTED', appeal: { state: 'PENDING' } });
    expect(h.file).toHaveBeenCalledWith(
      expect.objectContaining({ actor, idempotencyKey: 'key-1', input: fileBody }),
    );
  });
  it.each([
    ['a missing idempotency key', { 'idempotency-key': '' }, fileBody, 422],
    ['a foreign content type', { 'content-type': 'text/plain' }, fileBody, 415],
    ['a caller-chosen participant', {}, { ...fileBody, participantId: 'x' }, 422],
    ['a category outside the closed list', {}, { ...fileBody, reasonCategory: 'OTHER' }, 422],
  ])('rejects %s before any storage call', async (_name, headers, body, status) => {
    const h = host();
    const res = await createSkillAppealHandlers(h).FILE(post(body, headers));
    expect(res.status).toBe(status);
    expect(h.file).not.toHaveBeenCalled();
  });
  it('denies without a session and stops before reading the body', async () => {
    const h = host({
      actor: async () => {
        throw new SkillAppealHttpAuthorityError(401);
      },
    });
    const res = await createSkillAppealHandlers(h).FILE(post(fileBody));
    expect(res.status).toBe(401);
    expect(h.file).not.toHaveBeenCalled();
  });
  it('maps storage refusals without leaking which conflict applied', async () => {
    for (const code of [
      'SELF_ADJUDICATION',
      'ORIGINAL_REVIEWER',
      'GUILD_RELATIONSHIP',
      'FORBIDDEN',
    ]) {
      const h = host({
        adjudicate: async () => {
          throw new SkillAppealError(code as never);
        },
      });
      const res = await createSkillAppealHandlers(h).ADJUDICATE(post(decisionBody), appealId);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toMatch(/SELF|ORIGINAL|GUILD/);
    }
    for (const [code, status] of [
      ['WINDOW_CLOSED', 409],
      ['APPEAL_EXISTS', 409],
      ['ALREADY_DECIDED', 409],
      ['WRITES_DISABLED', 503],
      ['NOT_FOUND', 404],
      ['STORAGE_UNAVAILABLE', 503],
    ] as const) {
      const h = host({
        file: async () => {
          throw new SkillAppealError(code);
        },
      });
      expect((await createSkillAppealHandlers(h).FILE(post(fileBody))).status).toBe(status);
    }
  });
  it('takes the appeal id only from the path and decides with the session actor', async () => {
    const h = host();
    const res = await createSkillAppealHandlers(h).ADJUDICATE(post(decisionBody), appealId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ appeal: { state: 'UPHELD', grantsRank: false } });
    expect(h.adjudicate).toHaveBeenCalledWith(
      expect.objectContaining({ input: { ...decisionBody, appealId } }),
    );
    const bad = await createSkillAppealHandlers(h).ADJUDICATE(
      post({ ...decisionBody, appealId: randomUUID() }),
      appealId,
    );
    expect(bad.status).toBe(422);
    expect((await createSkillAppealHandlers(h).ADJUDICATE(post(decisionBody), 'nope')).status).toBe(
      422,
    );
  });
  it('treats an inconsistent storage result as a service fault, never a success', async () => {
    const wrongId = host({
      adjudicate: async () => ({
        status: 'EXECUTED',
        appeal: { ...view('DENIED'), id: randomUUID() },
      }),
    });
    expect(
      (await createSkillAppealHandlers(wrongId).ADJUDICATE(post(decisionBody), appealId)).status,
    ).toBe(503);
    const pending = host({ adjudicate: async () => ({ status: 'EXECUTED', appeal: view() }) });
    expect(
      (await createSkillAppealHandlers(pending).ADJUDICATE(post(decisionBody), appealId)).status,
    ).toBe(503);
    const grants = host({
      file: async () => ({ status: 'EXECUTED', appeal: { ...view(), grantsRank: true } }),
    });
    expect((await createSkillAppealHandlers(grants).FILE(post(fileBody))).status).toBe(503);
  });
});
