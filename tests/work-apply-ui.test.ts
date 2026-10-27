import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApplyToRaid, createApplyRunner } from '../src/components/work-apply';
import { WorkClientError } from '../src/work-http/workspace-client';

const slotId = '11111111-1111-4111-8111-111111111111';
const termsVersionId = '22222222-2222-4222-8222-222222222222';
const application = {
  status: 'EXECUTED' as const,
  application: {
    id: '33333333-3333-4333-8333-333333333333',
    slotId,
    termsVersionId,
    participantId: '44444444-4444-4444-8444-444444444444',
    evidenceRefs: [],
    state: 'SUBMITTED' as const,
  },
};
const input = { slotId, termsVersionId, evidenceRefs: [] };
describe('apply to a Raid', () => {
  it('renders an honest, non-binding action that never claims eligibility', () => {
    const html = renderToStaticMarkup(createElement(ApplyToRaid, { slotId, termsVersionId }));
    expect(html).toContain('Apply to this Raid');
    expect(html).toContain('An application is not a commitment');
    expect(html).toContain('Eligibility is checked');
    expect(html).toContain('JavaScript');
    expect(html).not.toContain('Eligible for me');
  });
  it('sends one request and reports it, then points to My Raid', async () => {
    const submitApplication = vi.fn(async () => application);
    const runner = createApplyRunner({ submitApplication }, () => 'key-1');
    expect(await runner.apply(input)).toEqual({ kind: 'DONE' });
    expect(submitApplication).toHaveBeenCalledWith(input, 'key-1');
  });
  it('keeps the same key for a retryable failure so a retry cannot duplicate', async () => {
    const keys = ['key-1', 'key-2', 'key-3'];
    const submitApplication = vi
      .fn()
      .mockRejectedValueOnce(new WorkClientError('SERVICE_UNAVAILABLE', 503, null))
      .mockResolvedValueOnce(application);
    const runner = createApplyRunner({ submitApplication }, () => keys.shift()!);
    expect(await runner.apply(input)).toMatchObject({ kind: 'RETRY_SAME_REQUEST' });
    expect(await runner.apply(input)).toEqual({ kind: 'DONE' });
    expect(submitApplication.mock.calls.map((call) => call[1])).toEqual(['key-1', 'key-1']);
  });
  it('drops the key after a definite answer and explains it without server text', async () => {
    const keys = ['key-1', 'key-2'];
    const submitApplication = vi
      .fn()
      .mockRejectedValueOnce(new WorkClientError('REVISION_CHANGED', 409, 'req-1'))
      .mockRejectedValueOnce(new WorkClientError('AUTHENTICATION_REQUIRED', 401, null));
    const runner = createApplyRunner({ submitApplication }, () => keys.shift()!);
    const changed = await runner.apply(input);
    expect(changed).toMatchObject({ kind: 'REFRESH' });
    const signedOut = await runner.apply(input);
    expect(signedOut).toMatchObject({ kind: 'SIGN_IN' });
    expect(submitApplication.mock.calls.map((call) => call[1])).toEqual(['key-1', 'key-2']);
    expect(JSON.stringify([changed, signedOut])).not.toContain('req-1');
  });
  it('ignores a second press while a request is in flight', async () => {
    let finish!: (value: typeof application) => void;
    const submitApplication = vi.fn(
      () => new Promise<typeof application>((resolve) => (finish = resolve)),
    );
    const runner = createApplyRunner({ submitApplication }, () => 'key-1');
    const first = runner.apply(input);
    expect(await runner.apply(input)).toEqual({ kind: 'BUSY' });
    finish(application);
    expect(await first).toEqual({ kind: 'DONE' });
    expect(submitApplication).toHaveBeenCalledTimes(1);
  });
});
