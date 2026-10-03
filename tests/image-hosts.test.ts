import { describe, expect, it } from 'vitest';
import { allowedImageUrl } from '../src/lib/image-hosts';
import { selectMarket } from '../src/lib/providers/market';

describe('allowedImageUrl', () => {
  it('accepts https URLs on allowlisted hosts', () => {
    expect(allowedImageUrl('https://pbs.twimg.com/x.png')).toBe(true);
    expect(allowedImageUrl('https://gateway.pinata.cloud/ipfs/bafy')).toBe(true);
  });
  it.each([
    'http://pbs.twimg.com/x.png',
    'https://evil.example/x.png',
    'https://u:p@pbs.twimg.com/',
    'https://pbs.twimg.com.evil.example/x.png',
    'https://pbs.twimg.com:8443/x.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    '/api/media/abc',
    '',
  ])('rejects %s', (value) => expect(allowedImageUrl(value)).toBe(false));
});
describe('market image', () => {
  const pair = (imageUrl: string) => [
    {
      chainId: 'solana',
      dexId: 'raydium',
      pairAddress: 'p',
      baseToken: { address: 'mint', name: 'N', symbol: 'S' },
      info: { imageUrl },
    },
  ];
  it('keeps only allowlisted hosts', () => {
    expect(selectMarket(pair('https://cdn.dexscreener.com/a.png') as never, 'mint')?.imageUri).toBe(
      'https://cdn.dexscreener.com/a.png',
    );
    expect(selectMarket(pair('https://evil.example/a.png') as never, 'mint')?.imageUri).toBe(
      undefined,
    );
  });
});
