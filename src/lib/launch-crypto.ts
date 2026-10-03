import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { HttpError } from './auth-primitives';

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const SEALED = /^s([A-Za-z0-9_]+):/;

function activeKey() {
  const version = process.env.LAUNCH_KEY_VERSION || '1';
  const value = process.env[`LAUNCH_KEY_${version}`];
  if (!value) throw new HttpError(503, 'Launch encryption key unavailable.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new HttpError(503, 'Launch encryption key invalid.');
  return { version, key };
}
function parts(value: string, count: number) {
  const fields = value.split(':');
  if (fields.length !== count) throw new Error('Malformed encrypted secret');
  return fields;
}
function openGcm(key: Buffer, ivText: string, tagText: string, bodyText: string, context: string) {
  const iv = Buffer.from(ivText, 'base64'),
    tag = Buffer.from(tagText, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return new Uint8Array(
    Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64')), decipher.final()]),
  );
}
export function encryptSecret(secret: Uint8Array, context: string) {
  const { version, key } = activeKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return `${version}:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}
export function decryptSecret(value: string, context: string) {
  const [version, iv, tag, body] = parts(value, 4);
  const key = Buffer.from(process.env[`LAUNCH_KEY_${version}`] || '', 'base64');
  if (key.length !== 32) throw new Error('Encryption key unavailable');
  return openGcm(key, iv, tag, body, context);
}
export function sealVersion() {
  return process.env.FEE_SEAL_VERSION || '1';
}
function sealKey(shared: Buffer, ephemeral: Buffer, context: string) {
  return Buffer.from(hkdfSync('sha256', shared, ephemeral, `useRAID fee:${context}`, 32));
}
// The web tier holds only the public half, so a fee-wallet secret it seals can be opened by the worker alone.
export function sealSecret(secret: Uint8Array, context: string) {
  const version = sealVersion();
  const raw = Buffer.from(process.env[`FEE_SEAL_PUBLIC_${version}`] || '', 'base64');
  if (raw.length !== 32) throw new HttpError(503, 'Fee sealing key unavailable.');
  const recipient = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = Buffer.from(
    ephemeral.publicKey.export({ format: 'der', type: 'spki' }),
  ).subarray(-32);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(shared, ephemeralPublic, context), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return `s${version}:${ephemeralPublic.toString('base64')}:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}
export function openSealedSecret(value: string, context: string) {
  const match = SEALED.exec(value);
  if (!match) throw new Error('Malformed encrypted secret');
  const [, ephemeralText, iv, tag, body] = parts(value, 5);
  const privateText = process.env[`FEE_SEAL_PRIVATE_${match[1]}`];
  if (!privateText) throw new Error('Fee sealing private key unavailable');
  const ephemeralPublic = Buffer.from(ephemeralText, 'base64');
  if (ephemeralPublic.length !== 32) throw new Error('Malformed encrypted secret');
  const shared = diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.from(privateText, 'base64'),
      format: 'der',
      type: 'pkcs8',
    }),
    publicKey: createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, ephemeralPublic]),
      format: 'der',
      type: 'spki',
    }),
  });
  return openGcm(sealKey(shared, ephemeralPublic, context), iv, tag, body, context);
}
export function decryptFeeSecret(value: string, context: string) {
  return SEALED.test(value) ? openSealedSecret(value, context) : decryptSecret(value, context);
}
export function generateSealKeyPair() {
  const pair = generateKeyPairSync('x25519');
  return {
    publicKey: Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' }))
      .subarray(-32)
      .toString('base64'),
    privateKey: Buffer.from(pair.privateKey.export({ format: 'der', type: 'pkcs8' })).toString(
      'base64',
    ),
  };
}
