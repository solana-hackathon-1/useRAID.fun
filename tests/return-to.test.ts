import { describe, expect, it } from 'vitest';
import { accountReturn, signInHref } from '../src/lib/return-to';

const listing = '11111111-1111-4111-8111-111111111111';
describe('sign-in return path', () => {
  it('sends the person to sign in with the page they came from', () => {
    expect(signInHref(`/raids/work/${listing}`)).toBe(
      `/creator/account?returnTo=${encodeURIComponent(`/raids/work/${listing}`)}`,
    );
  });
  it('returns to a Raid brief by its exact id, carried through X sign-in', () => {
    expect(accountReturn(`/raids/work/${listing}`)).toEqual({
      href: `/raids/work/${listing}`,
      label: 'Return to Raid',
      oauth: `work:${listing}`,
    });
  });
  it('keeps returning to a Creator Studio draft', () => {
    expect(accountReturn('/creator/new?draft=abc')).toEqual({
      href: '/creator/new?draft=abc',
      label: 'Return to draft',
    });
  });
  it('fails closed on a repeated returnTo query parameter instead of throwing', () => {
    expect(accountReturn(['/creator/a', '/creator/b'])).toBeNull();
    expect(accountReturn([`/raids/work/${listing}`])).toBeNull();
    expect(accountReturn([])).toBeNull();
  });
  it('rejects dot segments and encoded slashes in the draft path', () => {
    for (const bad of [
      '/creator/../api/admin',
      '/creator/a/../../api',
      '/creator/./new',
      '/creator/..',
      '/creator/%2e%2e/api',
      '/creator/%2E%2E/api',
      '/creator/.%2e/api',
      '/creator/a%2Fb',
      '/creator/a%2fb',
      '/creator/a%5Cb',
      '/creator/a%5cb',
      '/creator/a%252e%252e/b',
      '/creator/new/..?draft=1',
    ])
      expect(accountReturn(bad), bad).toBeNull();
  });
  it('still allows dots and encoded characters that are not path traversal', () => {
    for (const ok of [
      '/creator/new?draft=a..b',
      '/creator/new?next=%2Fx',
      '/creator/guild-drafts/a.b',
    ])
      expect(accountReturn(ok), ok).not.toBeNull();
  });
  it('ignores anything else, so the return link can never leave this site', () => {
    for (const bad of [
      undefined,
      '',
      'https://evil.example',
      '//evil.example',
      '/creator//evil.example',
      '/creator/\\evil.example',
      '/raids/work/not-a-uuid',
      `/raids/work/${listing}/x`,
      `/raids/work/${listing}?x=1`,
      '/raids',
    ])
      expect(accountReturn(bad), String(bad)).toBeNull();
  });
});
