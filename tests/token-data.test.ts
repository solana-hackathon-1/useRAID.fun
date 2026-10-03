import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/config')>();
  return { ...original, config: { ...original.config, demo: true } };
});
vi.mock('../src/lib/demo', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/demo')>();
  return {
    ...original,
    demoRaids: () =>
      original
        .demoRaids()
        .map((r, i) => (i === 1 ? { ...r, imageUri: 'https://img/token.png' } : r)),
  };
});
import { getToken } from '../src/lib/data';
import { demoRaids } from '../src/lib/demo';

describe('token page data', () => {
  it('passes a campaign image through to the token', async () => {
    const [first, second] = demoRaids();
    const token = await getToken(second.mint!);
    expect(token?.imageUri).toBe('https://img/token.png');
    expect((await getToken(first.mint!))?.imageUri).toBeNull();
  });
});
