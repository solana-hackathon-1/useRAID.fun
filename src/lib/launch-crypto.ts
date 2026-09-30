import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './auth-primitives';

function activeKey() {
  const version = process.env.LAUNCH_KEY_VERSION || '1';
  const value = process.env[`LAUNCH_KEY_${version}`];
  if (!value) throw new HttpError(503, 'Launch encryption key unavailable.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new HttpError(503, 'Launch encryption key invalid.');
  return { version, key };
}
export function encryptSecret(secret: Uint8Array, context: string) {
  const { version, key } = activeKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return `${version}:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}
export function decryptSecret(value: string, context: string) {
  const [version, iv, tag, body] = value.split(':');
  const key = Buffer.from(process.env[`LAUNCH_KEY_${version}`] || '', 'base64');
  if (key.length !== 32) throw new Error('Encryption key unavailable');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return new Uint8Array(
    Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]),
  );
}
