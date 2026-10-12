import { randomBytes } from 'node:crypto';
// Sign In With Solana allows only ASCII letters and digits in the nonce (8+ characters); base64url's
// '-' and '_' make wallets reject the message as badly formatted. 24 random bytes as hex keeps 192 bits.
export function siwsNonce() {
  return randomBytes(24).toString('hex');
}
