import { describe, expect, it } from 'vitest';
import { createPracticePortalHandlers } from '../src/skills/practice-portal-http';
import { PracticeTrialSubmissionStorageError } from '../src/skills/practice-trial-submission-storage';
import { definition } from '../examples/skill-assessments/fixtures';

const startId = '44444444-4444-4444-8444-444444444444';
const actor = { accountId: 'actual-user', sessionHash: 'a'.repeat(64) };
function handlers(submit: () => Promise<unknown>) {
  return createPracticePortalHandlers({
    version: 'v1',
    requestId: () => 'request-1',
    actor: async () => actor,
    checkOrigin: () => undefined,
    rateLimit: () => undefined,
    list: async () => ({}),
    read: async () => ({}),
    start: async () => ({}),
    submit,
  });
}
const request = () =>
  new Request('https://example.test/api/v1/practice/starts/' + startId + '/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'stable-key' },
    body: JSON.stringify({
      version: 'v1',
      startId,
      expectedDefinitionReference: definition.reference,
      expectedRubricReference: definition.rubric.reference,
      answer: 'a',
      explanation: 'b',
      toolsUsed: [],
      aiAssistanceUsed: false,
      assistanceDisclosure: 'none',
    }),
  });

describe('T014 submission rate limit over HTTP', () => {
  it('maps the storage limit to 429 RATE_LIMITED with a Retry-After header and private cache headers', async () => {
    const response = await handlers(async () => {
      throw new PracticeTrialSubmissionStorageError('RATE_LIMITED', 42);
    }).SUBMIT(request(), startId);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).error.code).toBe('RATE_LIMITED');
  });
  it('never invents Retry-After for other failures', async () => {
    const response = await handlers(async () => {
      throw new PracticeTrialSubmissionStorageError('ALREADY_SUBMITTED');
    }).SUBMIT(request(), startId);
    expect(response.headers.get('retry-after')).toBeNull();
  });
});
