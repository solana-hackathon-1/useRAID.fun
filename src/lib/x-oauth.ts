import { claimOAuthAttempt } from './identity-leaves';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type OAuthAttempt } from '@prisma/client';
import { db } from './db';
import { accountFoldsEnabled, config } from './config';
import { hash, random } from './auth-primitives';
import { adminXIds } from './admins';
import { allowedImageUrl } from './image-hosts';
import { absorbAccount, isEmptyAccount, lockIdentity } from './account-merge';
import { prepareIdentity, identityWriter, identityClock } from './identity-protocol';
import { runCommandTransaction } from './command-receipts-adapter';
import { replanIdentity } from '../identity-locks';
import { sweepIdentityLeaves } from './identity-cleanup';
import { HttpError } from './errors';
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
  await sweepIdentityLeaves('OAuthAttempt', new Date(), true);
  const requestedSession = sessionHash;
  await runCommandTransaction(db, async (_port, tx) => {
    const observed = requestedSession
      ? await tx.session.findUnique({
          where: { tokenHash: requestedSession },
          include: { user: true },
        })
      : null;
    const locks = await prepareIdentity(tx, {
      accounts: observed ? [{ id: observed.userId, mode: 'SHARE' }] : [],
    });
    const now = await identityClock(tx);
    const session = requestedSession
      ? await tx.session.findUnique({
          where: { tokenHash: requestedSession },
          include: { user: true },
        })
      : null;
    if (session && session.userId !== observed?.userId) replanIdentity();
    const active = session && session.expiresAt > now && !session.user.suspended ? session : null;
    clearSession = !!requestedSession && !active;
    await identityWriter(tx, locks).oAuthAttempt.create({
      data: {
        stateHash: hash(state),
        verifier,
        expiresAt: new Date(now.getTime() + 600000),
        userId: active?.userId,
        sessionHash: active ? requestedSession : null,
      },
    });
  });
  return { state, url: authorizationUrl(state, verifier), clearSession };
}
export async function claimAttempt(state: string, sessionHash: string | null) {
  // Keep the claimed row until completion so disconnect can cancel an in-flight callback.
  const claimed = await claimOAuthAttempt(hash(state), sessionHash, new Date());
  if (claimed.count !== 1) throw new OAuthError('state');
  const attempt = await db.oAuthAttempt.findUnique({ where: { stateHash: hash(state) } });
  if (!attempt) throw new OAuthError('state');
  return attempt;
}
export async function completeConnection(attempt: OAuthAttempt, profile: XIdentity) {
  // Provider exchange is outside this retry boundary. Stable local IDs survive every re-plan.
  const sessionToken = random(),
    newUserId = randomUUID();
  try {
    await runCommandTransaction(db, async (_port, tx) => {
      const observedOwner = attempt.userId
        ? await tx.user.findUnique({ where: { id: attempt.userId } })
        : null;
      if (attempt.userId && !observedOwner) throw new OAuthError('session');
      if (observedOwner?.xId && observedOwner.xId !== profile.id) throw new OAuthError('identity');
      const observedUser = await tx.user.findUnique({ where: { xId: profile.id } });
      let fold: { keep: string; drop: string } | undefined;
      if (observedOwner && observedUser && observedOwner.id !== observedUser.id) {
        if (
          !accountFoldsEnabled() ||
          observedOwner.xId ||
          (await tx.walletIdentity.findUnique({ where: { userId: observedUser.id } }))
        )
          throw new OAuthError('identity');
        // A2: reject known activity before the strong merge roots; guarded check follows below.
        if (await isEmptyAccount(tx, observedOwner.id))
          fold = { keep: observedUser.id, drop: observedOwner.id };
        else if (await isEmptyAccount(tx, observedUser.id))
          fold = { keep: observedOwner.id, drop: observedUser.id };
        else throw new OAuthError('identity');
      }
      const accounts = fold
        ? [
            { id: fold.keep, mode: 'UPDATE' as const },
            { id: fold.drop, mode: 'UPDATE' as const },
          ]
        : observedOwner
          ? [
              {
                id: observedOwner.id,
                mode: observedOwner.xId ? ('NO KEY UPDATE' as const) : ('UPDATE' as const),
              },
            ]
          : observedUser
            ? [{ id: observedUser.id, mode: 'NO KEY UPDATE' as const }]
            : [{ id: newUserId, mode: 'UPDATE' as const, create: true }];
      const locks = await prepareIdentity(tx, {
        accounts,
        xIds: [profile.id],
        balances: fold ? [fold.keep, fold.drop] : [],
        attemptHashes: [attempt.stateHash],
      });
      const writes = identityWriter(tx, locks),
        now = await identityClock(tx);
      let owner = attempt.userId
        ? await tx.user.findUnique({ where: { id: attempt.userId } })
        : null;
      let user = await tx.user.findUnique({ where: { xId: profile.id } });
      if (owner?.xId !== observedOwner?.xId || user?.id !== observedUser?.id) replanIdentity();
      const live = await tx.oAuthAttempt.findUnique({ where: { stateHash: attempt.stateHash } });
      if (
        !live?.consumedAt ||
        live.expiresAt <= now ||
        live.userId !== attempt.userId ||
        live.sessionHash !== attempt.sessionHash
      )
        throw new OAuthError('state');
      if (attempt.userId) {
        const session = attempt.sessionHash
          ? await tx.session.findUnique({ where: { tokenHash: attempt.sessionHash } })
          : null;
        if (!session || session.userId !== attempt.userId || session.expiresAt <= now)
          throw new OAuthError('session');
      }
      if (owner?.suspended || user?.suspended) throw new OAuthError('suspended');
      if (fold) {
        await absorbAccount(tx, fold.keep, fold.drop, locks);
        user = await tx.user.findUniqueOrThrow({ where: { id: fold.keep } });
        owner = null;
      }
      const admin = adminXIds().includes(profile.id);
      const access = (role?: string) =>
        admin ? { role: 'ADMIN' } : role === 'ADMIN' ? { role: 'CREATOR' } : {};
      const target = owner || user;
      if (target) {
        const bound = await writes.user.updateMany({
          where: { id: target.id, OR: [{ xId: null }, { xId: profile.id }] },
          data: {
            // A same-X reconnect must not write the key column under a weaker root.
            ...(target.xId ? {} : { xId: profile.id }),
            handle: profile.username,
            ...access(target.role),
          },
        });
        if (bound.count !== 1) throw new OAuthError('identity');
        user = await tx.user.findUniqueOrThrow({ where: { id: target.id } });
      } else
        user = await writes.user.create({
          data: {
            id: newUserId,
            xId: profile.id,
            handle: profile.username,
            role: admin ? 'ADMIN' : 'CREATOR',
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
      await writes.xAccount.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...data },
        update: data,
      });
      // Merge may already have deleted the attempt/session; no second acquisition is allowed.
      if (await tx.oAuthAttempt.findUnique({ where: { stateHash: attempt.stateHash } }))
        await writes.oAuthAttempt.deleteMany({ where: { stateHash: attempt.stateHash } });
      if (
        attempt.sessionHash &&
        (await tx.session.findUnique({ where: { tokenHash: attempt.sessionHash } }))
      )
        await writes.session.deleteMany({ where: { tokenHash: attempt.sessionHash } });
      await writes.session.create({
        data: {
          tokenHash: hash(sessionToken),
          userId: user.id,
          via: 'x',
          expiresAt: new Date(now.getTime() + 7 * 86400000),
        },
      });
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) throw new OAuthError('identity');
    throw error;
  }
  return sessionToken;
}
export async function disconnectX(userId: string) {
  await runCommandTransaction(db, async (_port, tx) => {
    const locks = await prepareIdentity(tx, { accounts: [{ id: userId, mode: 'NO KEY UPDATE' }] });
    const writes = identityWriter(tx, locks);
    await writes.oAuthAttempt.deleteMany({ where: { userId } });
    await writes.xAccount.deleteMany({ where: { userId } });
  });
}
