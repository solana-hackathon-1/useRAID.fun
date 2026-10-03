import { cookies } from 'next/headers';
import { isIP } from 'node:net';
import { hash, HttpError } from './auth-primitives';
export { hash, random, HttpError } from './auth-primitives';
import { db } from './db';
import { config } from './config';
import { sessionCookie } from './studio-mode';
export const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production' || config.appUrl.startsWith('https:'),
  path: '/',
};
export async function currentUser() {
  if (config.demo) return null;
  const value = (await cookies()).get(sessionCookie())?.value;
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
export function checkOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(config.appUrl).origin)
    throw new HttpError(403, 'Request origin rejected.');
  if (config.demo)
    throw new HttpError(
      403,
      'Demo mode is read-only. Connect the database and X account to enable this action.',
    );
}
export async function rateLimit(key: string, limit: number, seconds: number, cost = 1) {
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const row = await db.rateLimit.upsert({
    where: { key: `${key}:${bucket}` },
    create: {
      key: `${key}:${bucket}`,
      count: cost,
      expiresAt: new Date((bucket + 1) * seconds * 1000),
    },
    update: { count: { increment: cost } },
  });
  if (row.count > limit) throw new HttpError(429, 'Too many requests. Try again later.');
}
export function clientIp(request: Request): string | null {
  const header = process.env.TRUSTED_IP_HEADER;
  if (!header) return null;
  // The last entry is the hop the trusted proxy appended; earlier entries are client-forgeable.
  const value = request.headers.get(header)?.split(',').at(-1)?.trim();
  return value && isIP(value) ? value : null;
}
export function clientKey(request: Request) {
  const ip = clientIp(request);
  return ip ? hash(ip) : null;
}
let warnedShared = false;
export async function publicRateLimit(
  request: Request,
  scope: string,
  limit: number,
  seconds: number,
  sharedLimit: number,
) {
  const ip = clientIp(request);
  if (ip) return rateLimit(`${scope}:ip:${hash(ip)}`, limit, seconds);
  if (!warnedShared && process.env.NODE_ENV === 'production') {
    warnedShared = true;
    console.warn(
      'TRUSTED_IP_HEADER is unset or invalid: public rate limits fall back to one shared bucket.',
    );
  }
  return rateLimit(`${scope}:shared`, sharedLimit, seconds);
}
