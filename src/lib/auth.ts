import { cookies } from 'next/headers';
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db';
import { config } from './config';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const random = () => randomBytes(32).toString('base64url');
export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.appUrl.startsWith('https:'),
  path: '/',
};
export async function currentUser() {
  if (config.demo) return null;
  const value = (await cookies()).get('raid_session')?.value;
  if (!value) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hash(value) },
    include: { user: true },
  });
  return session && session.expiresAt > new Date() && !session.user.suspended ? session.user : null;
}
export async function requireUser(admin = false) {
  const user = await currentUser();
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  if (admin && user.role !== 'ADMIN') throw new HttpError(403, 'Administrator access required.');
  return user;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function checkOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(config.appUrl).origin)
    throw new HttpError(403, 'Request origin rejected.');
  if (config.demo)
    throw new HttpError(
      403,
      'Demo mode is read-only. Connect the database and X account to enable this action.',
    );
}
export async function rateLimit(key: string, limit: number, seconds: number) {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const row = await db.rateLimit.upsert({
    where: { key: `${key}:${bucket}` },
    create: {
      key: `${key}:${bucket}`,
      count: 1,
      expiresAt: new Date((bucket + 1) * seconds * 1000),
    },
    update: { count: { increment: 1 } },
  });
  if (row.count > limit) throw new HttpError(429, 'Too many requests. Try again later.');
}
export function clientKey(request: Request) {
  const header = process.env.TRUSTED_IP_HEADER;
  return hash(
    header ? request.headers.get(header)?.split(',')[0].trim() || 'unknown' : 'shared-public',
  );
}
