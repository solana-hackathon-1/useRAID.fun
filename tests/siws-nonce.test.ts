import { describe, expect, it } from 'vitest';
import { siwsNonce } from '../src/lib/siws-nonce';

// Sign In With Solana: message-nonce = 8*( ALPHA / DIGIT ). Wallets reject anything else as
// "invalid formatting", so base64url ('-' and '_') nonces fail about two thirds of the time.
describe('SIWS nonce', () => {
  it('is always at least 8 ASCII letters or digits', () => {
    for (let i = 0; i < 2000; i++) expect(siwsNonce()).toMatch(/^[A-Za-z0-9]{8,}$/);
  });
  it('is unique per call', () => {
    expect(new Set(Array.from({ length: 500 }, siwsNonce)).size).toBe(500);
  });
});
