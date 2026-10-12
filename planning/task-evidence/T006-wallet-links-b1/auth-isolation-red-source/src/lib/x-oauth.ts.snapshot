import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { OAuthAttempt } from '@prisma/client';
import { db } from './db';
import { config } from './config';
import { hash, random } from './auth-primitives';
import { adminXIds } from './admins';
import { allowedImageUrl } from './image-hosts';
import { absorbAccount, isEmptyAccount, lockIdentity } from './account-merge';
import { reserveUsage, settleReservation } from './providers/x';

export class OAuthError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function oauthConfig() {
  const origin = new URL(config.appUrl);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')
  )
    throw new OAuthError('unavailable');
  const clientId = process.env.X_CLIENT_ID?.trim();
  const clientSecret = process.env.X_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || config.demo) throw new OAuthError('unavailable');
  return { clientId, clientSecret, callback: `${origin.origin}/api/auth/x/callback` };
}
export function authorizationUrl(state: string, verifier: string) {
  const { clientId, callback } = oauthConfig();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: callback,
    scope: 'tweet.read users.read',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return `https://x.com/i/oauth2/authorize?${query}`;
}
const STATE = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATES = 3;
// The state cookie holds up to a few dot-joined states so a second tab does not invalidate the first.
function states(cookie: string | undefined) {
  return (cookie || '').split('.').filter((s) => STATE.test(s));
}
export function addState(cookie: string | undefined, state: string) {
  return [...states(cookie).filter((s) => s !== state), state].slice(-MAX_STATES).join('.');
}
export function removeState(cookie: string | undefined, state: string) {
  return states(cookie)
    .filter((s) => s !== state)
    .join('.');
}
export function validState(state: string | null, cookie: string | undefined) {
  if (!state || !cookie || !STATE.test(state)) return false;
  let match = false;
  for (const candidate of states(cookie))
    if (timingSafeEqual(Buffer.from(state), Buffer.from(candidate))) match = true;
  return match;
}
const profileSchema = z.object({
  data: z.object({
    id: z.string().regex(/^\d+$/),
    username: z.string().min(1).max(50),
    name: z.string().min(1).max(200),
    profile_image_url: z
      .string()
      .url()
      .refine((v) => new URL(v).protocol === 'https:')
      .optional(),
  }),
});
export async function fetchXIdentity(code: string, verifier: string) {
  const { clientId, clientSecret, callback } = oauthConfig();
  try {
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    const token = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!token.ok) throw new OAuthError('provider');
    const credentials = z
      .object({
        access_token: z.string().min(1),
        token_type: z.string().refine((v) => v.toLowerCase() === 'bearer'),
      })
      .parse(await token.json());
    const reservation = await reserveUsage(1, undefined, true);
    const me = await fetch('https://api.x.com/2/users/me?user.fields=profile_image_url', {
      headers: { Authorization: `Bearer ${credentials.access_token}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    }).catch(async (error) => {
      if (!(error instanceof DOMException && error.name === 'TimeoutError'))
        await settleReservation(reservation.id, 0, 'Transport failure; no response');
      throw error;
    });
    if (!me.ok) {
      await settleReservation(reservation.id, 0, `X returned ${me.status}; nothing billable`);
      throw new OAuthError('provider');
    }
    return profileSchema.parse(await me.json()).data;
  } catch {
    throw new OAuthError('provider');
  }
}
export type XIdentity = Awaited<ReturnType<typeof fetchXIdentity>>;
export { lockIdentity };
export async function startAttempt(sessionHash: string | null) {
  oauthConfig();
  const state = random(),
    verifier = random();
  let clearSession = false;
  await db.$transaction(async (tx) => {
    let session = sessionHash
      ? await tx.session.findUnique({ where: { tokenHash: sessionHash }, include: { user: true } })
      : null;
    if (sessionHash && (!session || session.expiresAt <= new Date() || session.user.suspended)) {
      session = null;
      sessionHash = null;
      clearSession = true;
    }
    if (session?.user.xId) await lockIdentity(tx, session.user.xId);
    await tx.oAuthAttempt.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    await tx.oAuthAttempt.create({
      data: {
        stateHash: hash(state),
        verifier,
        expiresAt: new Date(Date.now() + 600000),
        userId: session?.userId,
        sessionHash,
      },
    });
  });
  return { state, url: authorizationUrl(state, verifier), clearSession };
}
export async function claimAttempt(state: string, sessionHash: string | null) {
  // Keep the claimed row until completion so disconnect can cancel an in-flight callback.
  const claimed = await db.oAuthAttempt.updateMany({
    where: {
      stateHash: hash(state),
      consumedAt: null,
      expiresAt: { gt: new Date() },
      sessionHash,
    },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) throw new OAuthError('state');
  const attempt = await db.oAuthAttempt.findUnique({ where: { stateHash: hash(state) } });
  if (!attempt) throw new OAuthError('state');
  return attempt;
}
let warnedAutoApprove = false;
export async function completeConnection(attempt: OAuthAttempt, profile: XIdentity) {
  const sessionToken = random();
  await db.$transaction(async (tx) => {
    // Lock the permanent owner even for an attempted connection to a different identity.
    let owner = attempt.userId ? await tx.user.findUnique({ where: { id: attempt.userId } }) : null;
    if (attempt.userId && !owner) throw new OAuthError('session');
    await lockIdentity(tx, owner?.xId || profile.id);
    const live = await tx.oAuthAttempt.deleteMany({
      where: {
        stateHash: attempt.stateHash,
        consumedAt: { not: null },
        expiresAt: { gt: new Date() },
      },
    });
    if (live.count !== 1) throw new OAuthError('state');
    if (attempt.userId) {
      const session = await tx.session.findUnique({ where: { tokenHash: attempt.sessionHash! } });
      if (!session || session.userId !== attempt.userId || session.expiresAt <= new Date())
        throw new OAuthError('session');
      if (owner!.xId && owner!.xId !== profile.id) throw new OAuthError('identity');
    }
    let user = await tx.user.findUnique({ where: { xId: profile.id } });
    if (user?.suspended) throw new OAuthError('suspended');
    if (owner && user && owner.id !== user.id) {
      // Two accounts for one person: fold the one with no activity into the other.
      if (owner.xId || (await tx.walletIdentity.findUnique({ where: { userId: user.id } })))
        throw new OAuthError('identity');
      if (await isEmptyAccount(tx, owner.id)) {
        await absorbAccount(tx, user.id, owner.id);
        owner = null;
      } else if (await isEmptyAccount(tx, user.id)) {
        await absorbAccount(tx, owner.id, user.id);
        user = null;
      } else throw new OAuthError('identity');
    }
    const admin = adminXIds().includes(profile.id);
    const localAutoApprove =
      process.env.NODE_ENV !== 'production' && process.env.LOCAL_AUTO_APPROVE_CREATORS === 'true';
    if (localAutoApprove && !warnedAutoApprove) {
      warnedAutoApprove = true;
      console.warn('LOCAL_AUTO_APPROVE_CREATORS is on: every X sign-in is approved as a creator.');
    }
    // Admin comes from the environment allowlist on every sign-in; a stored ADMIN role that fell off it is demoted.
    const access = (role?: string) =>
      admin
        ? { role: 'ADMIN', approved: true }
        : {
            ...(role === 'ADMIN' ? { role: 'CREATOR' } : {}),
            ...(localAutoApprove ? { approved: true } : {}),
          };
    user = owner
      ? await tx.user.update({
          where: { id: owner.id },
          data: {
            xId: profile.id,
            handle: profile.username,
            ...access(owner.role),
          },
        })
      : await tx.user.upsert({
          where: { xId: profile.id },
          create: {
            xId: profile.id,
            handle: profile.username,
            role: admin ? 'ADMIN' : 'CREATOR',
            approved: admin || localAutoApprove,
          },
          update: {
            handle: profile.username,
            ...access(user?.role),
          },
        });
    const existing = await tx.xAccount.findUnique({ where: { xUserId: profile.id } });
    if (existing && existing.userId !== user.id) throw new OAuthError('identity');
    const data = {
      xUserId: profile.id,
      username: profile.username,
      displayName: profile.name,
      profileImage:
        profile.profile_image_url && allowedImageUrl(profile.profile_image_url)
          ? profile.profile_image_url
          : null,
    };
    await tx.xAccount.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });
    if (attempt.sessionHash)
      await tx.session.deleteMany({ where: { tokenHash: attempt.sessionHash } });
    await tx.session.create({
      data: {
        tokenHash: hash(sessionToken),
        userId: user.id,
        via: 'x',
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
  });
  return sessionToken;
}
export async function disconnectX(userId: string) {
  await db.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.xId) await lockIdentity(tx, user.xId);
    await tx.oAuthAttempt.deleteMany({ where: { userId } });
    await tx.xAccount.deleteMany({ where: { userId } });
  });
}
