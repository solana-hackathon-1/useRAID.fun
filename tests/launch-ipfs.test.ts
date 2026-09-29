import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAsset, validateImage, verifyAsset } from '../src/lib/launch-ipfs';

const logo = 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyvu';
const other = 'ipfs://bafybeigdyrzt4j5q2p3x7uh5tlvnruzbwpjlvszwncln6q2jv7idv2uyva';
const previous = process.env.LAUNCH_KEY_1;
describe('server-verified launch images', () => {
  beforeAll(() => {
    process.env.LAUNCH_KEY_1 = Buffer.alloc(32, 7).toString('base64');
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.LAUNCH_KEY_1;
    else process.env.LAUNCH_KEY_1 = previous;
  });
  it('binds uploaded CID to user, image kind, and expiry', () => {
    const proof = signAsset(logo, 'logo', 'owner');
    expect(() => verifyAsset(logo, 'logo', 'owner', proof)).not.toThrow();
    expect(() => verifyAsset(logo, 'banner', 'owner', proof)).toThrow();
    expect(() => verifyAsset(logo, 'logo', 'other-owner', proof)).toThrow();
    expect(() => verifyAsset(other, 'logo', 'owner', proof)).toThrow();
    const [version, , signature] = proof.split('.');
    expect(() => verifyAsset(logo, 'logo', 'owner', `${version}.1.${signature}`)).toThrow();
  });
  it('rejects content that only claims to be a valid image', async () => {
    await expect(
      validateImage(new File(['not PNG'], 'logo.png', { type: 'image/png' }), 'logo'),
    ).rejects.toThrow();
    await expect(
      validateImage(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.gif'), 'banner'),
    ).rejects.toThrow();
  });
});
