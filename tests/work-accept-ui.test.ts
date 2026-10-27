import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AcceptRaid, createAcceptRunner } from '../src/components/work-accept';
import { WorkClientError } from '../src/work-http/workspace-client';

const slotId = '11111111-1111-4111-8111-111111111111';
const termsVersionId = '22222222-2222-4222-8222-222222222222';
const offerId = '33333333-3333-4333-8333-333333333333';
const termsDigest = 'a'.repeat(64);
const consent = { status: 'EXECUTED' as const, consent: {} as never };
const committed = { status: 'EXECUTED' as const, engagement: {} as never } as never;
const input = { slotId, termsVersionId, termsDigest };
const keys = () => {
  let n = 0;
  return () => 'key-' + ++n;
};
describe('accept a Raid', () => {
  it('renders consent and an accept button disabled until JavaScript is ready, with no eligibility claim', () => {
    const html = renderToStaticMarkup(
      createElement(AcceptRaid, { slotId, termsVersionId, termsDigest }),
    );
    expect(html).toContain('name="accept-form"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('I have read the terms above');
    expect(html).toContain('Accept this Raid');
    expect(html).toContain('disabled');
    expect(html).toContain('Eligibility is checked');
    expect(html).not.toContain('Eligible for me');
    expect(html).not.toContain(termsDigest);
  });
  it('records consent to the shown digest and then accepts, with one key per step', async () => {
    const recordConsent = vi.fn(async () => consent);
    const acceptRaid = vi.fn(async () => committed);
    const runner = createAcceptRunner({ recordConsent, acceptRaid }, keys());
    expect(await runner.accept(input)).toEqual({ kind: 'DONE' });
    expect(recordConsent).toHaveBeenCalledWith(input, 'key-1');
    expect(acceptRaid).toHaveBeenCalledWith({ slotId, termsVersionId }, 'key-2');
  });
  it('accepts through the Founder offer when one is given', async () => {
    const acceptRaid = vi.fn(async () => committed);
    const runner = createAcceptRunner(
      { recordConsent: vi.fn(async () => consent), acceptRaid },
      keys(),
    );
    await runner.accept({ ...input, offerId });
    expect(acceptRaid).toHaveBeenCalledWith({ slotId, termsVersionId, offerId }, 'key-2');
  });
  it('never accepts when the consent step failed', async () => {
    const acceptRaid = vi.fn(async () => committed);
    const recordConsent = vi
      .fn()
      .mockRejectedValue(new WorkClientError('TERMS_VERSION_CHANGED', 409));
    const runner = createAcceptRunner({ recordConsent, acceptRaid }, keys());
    expect(await runner.accept(input)).toMatchObject({ kind: 'REFRESH' });
    expect(acceptRaid).not.toHaveBeenCalled();
  });
  it('keeps both keys across an unconfirmed failure so a retry cannot duplicate either step', async () => {
    const recordConsent = vi.fn(async () => consent);
    const acceptRaid = vi
      .fn()
      .mockRejectedValueOnce(new WorkClientError('SERVICE_UNAVAILABLE', 503))
      .mockResolvedValueOnce(committed);
    const runner = createAcceptRunner({ recordConsent, acceptRaid }, keys());
    expect(await runner.accept(input)).toMatchObject({ kind: 'RETRY_SAME_REQUEST' });
    expect(await runner.accept(input)).toEqual({ kind: 'DONE' });
    expect(recordConsent.mock.calls.map((c) => c[1])).toEqual(['key-1', 'key-1']);
    expect(acceptRaid.mock.calls.map((c) => c[1])).toEqual(['key-2', 'key-2']);
  });
  it('drops only the failed step key after a definite answer', async () => {
    const recordConsent = vi.fn(async () => consent);
    const acceptRaid = vi
      .fn()
      .mockRejectedValueOnce(new WorkClientError('CAPACITY_CONFLICT', 409))
      .mockResolvedValueOnce(committed);
    const runner = createAcceptRunner({ recordConsent, acceptRaid }, keys());
    expect(await runner.accept(input)).toMatchObject({ kind: 'NONE' });
    expect(await runner.accept(input)).toEqual({ kind: 'DONE' });
    expect(acceptRaid.mock.calls.map((c) => c[1])).toEqual(['key-2', 'key-3']);
  });
  it('ignores a second press while a request is in flight', async () => {
    let finish!: (value: typeof consent) => void;
    const recordConsent = vi.fn(() => new Promise<typeof consent>((resolve) => (finish = resolve)));
    const acceptRaid = vi.fn(async () => committed);
    const runner = createAcceptRunner({ recordConsent, acceptRaid }, keys());
    const first = runner.accept(input);
    expect(await runner.accept(input)).toEqual({ kind: 'BUSY' });
    finish(consent);
    expect(await first).toEqual({ kind: 'DONE' });
    expect(recordConsent).toHaveBeenCalledTimes(1);
  });
});
