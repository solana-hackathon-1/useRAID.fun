import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  decryptFeeSecret,
  decryptSecret,
  encryptSecret,
  generateSealKeyPair,
  openSealedSecret,
  sealSecret,
} from '../src/lib/launch-crypto';

const names = [
  'LAUNCH_KEY_VERSION',
  'LAUNCH_KEY_1',
  'LAUNCH_KEY_2',
  'FEE_SEAL_VERSION',
  'FEE_SEAL_PUBLIC_1',
  'FEE_SEAL_PRIVATE_1',
] as const;
const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
const secret = new Uint8Array(64).map((_, i) => i);
let pair: ReturnType<typeof generateSealKeyPair>;
beforeEach(() => {
  for (const n of names) delete process.env[n];
  process.env.LAUNCH_KEY_1 = Buffer.alloc(32, 3).toString('base64');
  pair = generateSealKeyPair();
  process.env.FEE_SEAL_PUBLIC_1 = pair.publicKey;
  process.env.FEE_SEAL_PRIVATE_1 = pair.privateKey;
});
afterEach(() => {
  for (const n of names)
    if (previous[n] === undefined) delete process.env[n];
    else process.env[n] = previous[n];
});

describe('sealed fee-wallet secrets', () => {
  it('round-trips and binds the context', () => {
    const sealed = sealSecret(secret, 'fee:mint');
    expect(sealed).toMatch(/^s1:/);
    expect([...openSealedSecret(sealed, 'fee:mint')]).toEqual([...secret]);
    expect(() => openSealedSecret(sealed, 'fee:other')).toThrow();
  });
  it('rejects a tampered body', () => {
    const fields = sealSecret(secret, 'fee:mint').split(':');
    const body = Buffer.from(fields[4], 'base64');
    body[0] ^= 1;
    fields[4] = body.toString('base64');
    expect(() => openSealedSecret(fields.join(':'), 'fee:mint')).toThrow();
  });
  it('needs the private key, which the web tier does not hold', () => {
    const sealed = sealSecret(secret, 'fee:mint');
    delete process.env.FEE_SEAL_PRIVATE_1;
    expect(() => openSealedSecret(sealed, 'fee:mint')).toThrow(/private key unavailable/);
  });
  it('cannot be opened with a different private key', () => {
    const sealed = sealSecret(secret, 'fee:mint');
    process.env.FEE_SEAL_PRIVATE_1 = generateSealKeyPair().privateKey;
    expect(() => openSealedSecret(sealed, 'fee:mint')).toThrow();
  });
  it('dispatches on the stored prefix', () => {
    expect([...decryptFeeSecret(sealSecret(secret, 'c'), 'c')]).toEqual([...secret]);
    expect([...decryptFeeSecret(encryptSecret(secret, 'c'), 'c')]).toEqual([...secret]);
  });
});

describe('symmetric launch secrets', () => {
  it('still decrypts legacy values with their own key version', () => {
    const legacy = encryptSecret(secret, 'mint:m');
    expect(legacy).toMatch(/^1:/);
    process.env.LAUNCH_KEY_2 = Buffer.alloc(32, 9).toString('base64');
    process.env.LAUNCH_KEY_VERSION = '2';
    expect(encryptSecret(secret, 'mint:m')).toMatch(/^2:/);
    expect([...decryptSecret(legacy, 'mint:m')]).toEqual([...secret]);
  });
  it('rejects a truncated tag, a wrong IV length and extra fields', () => {
    const [version, iv, tag, body] = encryptSecret(secret, 'c').split(':');
    const short = Buffer.from(tag, 'base64').subarray(0, 8).toString('base64');
    expect(() => decryptSecret([version, iv, short, body].join(':'), 'c')).toThrow(/Malformed/);
    const wrongIv = randomBytes(16).toString('base64');
    expect(() => decryptSecret([version, wrongIv, tag, body].join(':'), 'c')).toThrow(/Malformed/);
    expect(() => decryptSecret([version, iv, tag, body, 'x'].join(':'), 'c')).toThrow(/Malformed/);
  });
  it('does not accept a short GCM tag even when it authenticates', () => {
    const key = Buffer.alloc(32, 3),
      iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 8 });
    cipher.setAAD(Buffer.from('c'));
    const body = Buffer.concat([cipher.update(secret), cipher.final()]);
    const value = [
      '1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ];
    expect(() => decryptSecret(value.join(':'), 'c')).toThrow(/Malformed/);
  });
});
