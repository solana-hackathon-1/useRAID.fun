import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from './db';
import { sessionCookie, studioSandbox } from './studio-mode';
import {
  hash,
  cookieOptions,
  checkOrigin,
  requireUser,
  rateLimit,
  publicRateLimit,
  HttpError,
} from './auth';
import {
  OAuthError,
  oauthConfig,
  startAttempt,
  validState,
  addState,
  removeState,
  claimAttempt,
  fetchXIdentity,
  completeConnection,
  disconnectX,
} from './x-oauth';

const RETURNS: Record<string, string> = {
  creator: '/creator',
  account: '/creator/account',
  admin: '/admin',
};
function returnDestination(value: string | null | undefined) {
  if (!value) return null;
  if (Object.hasOwn(RETURNS, value)) return RETURNS[value];
  return /^raid:[a-z0-9]{20,40}$/.test(value) ? `/raids/${value.slice(5)}` : null;
}
function result(status: string, dest = '/creator') {
  // Destinations come from a fixed table or a strict id pattern, never from the request itself.
  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: `${dest}?auth=${status}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
function isPrefetch(request: Request) {
  const { headers } = request;
  return (
    headers.has('next-router-prefetch') ||
    /prefetch/i.test(headers.get('sec-purpose') || '') ||
    /prefetch/i.test(headers.get('purpose') || '')
  );
}
export async function startX(request: Request) {
  if (studioSandbox()) return NextResponse.redirect(new URL('/studio-test', request.url));
  // A router prefetch must not spend rate limit, write an attempt, or set a state cookie.
  if (isPrefetch(request))
    return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  try {
    oauthConfig();
    const jar = await cookies();
    const raw = jar.get(sessionCookie())?.value;
    if (raw) await rateLimit(`oauth:session:${hash(raw)}`, 30, 600);
    else await publicRateLimit(request, 'oauth', 30, 600, 600);
    const attempt = await startAttempt(raw ? hash(raw) : null);
    const response = NextResponse.redirect(attempt.url);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.cookies.set('raid_oauth', addState(jar.get('raid_oauth')?.value, attempt.state), {
      ...cookieOptions,
      maxAge: 600,
    });
    const requested = new URL(request.url).searchParams.get('return');
    if (requested && returnDestination(requested))
      response.cookies.set('raid_oauth_return', requested, { ...cookieOptions, maxAge: 600 });
    else response.cookies.set('raid_oauth_return', '', { ...cookieOptions, maxAge: 0 });
    if (attempt.clearSession)
      response.cookies.set(sessionCookie(), '', { ...cookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    return result(error instanceof OAuthError ? error.code : 'failed');
  }
}
export async function callbackX(request: Request) {
  if (studioSandbox()) return NextResponse.redirect(new URL('/studio-test', request.url));
  const jar = await cookies();
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const stateCookie = jar.get('raid_oauth')?.value;
  const dest = returnDestination(jar.get('raid_oauth_return')?.value) || undefined;
  let claimed = false;
  let response: NextResponse;
  try {
    if (!validState(state, stateCookie)) throw new OAuthError('state');
    const raw = jar.get(sessionCookie())?.value;
    const attempt = await claimAttempt(state!, raw ? hash(raw) : null);
    claimed = true;
    if (url.searchParams.has('error'))
      throw new OAuthError(
        url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'provider',
      );
    const code = url.searchParams.get('code');
    if (!code || code.length > 2048) throw new OAuthError('state');
    const profile = await fetchXIdentity(code, attempt.verifier);
    const token = await completeConnection(attempt, profile);
    response = result('connected', dest);
    response.cookies.set(sessionCookie(), token, { ...cookieOptions, maxAge: 7 * 86400 });
  } catch (error) {
    response = result(error instanceof OAuthError ? error.code : 'failed', dest);
    if (error instanceof OAuthError && error.code === 'session')
      response.cookies.set(sessionCookie(), '', { ...cookieOptions, maxAge: 0 });
  } finally {
    if (claimed)
      await db.oAuthAttempt.deleteMany({ where: { stateHash: hash(state!) } }).catch(() => {});
  }
  // Another tab may still be mid-authorization, so only the state used here is dropped.
  const remaining = removeState(stateCookie, state || '');
  if (remaining) response.cookies.set('raid_oauth', remaining, { ...cookieOptions, maxAge: 600 });
  else response.cookies.set('raid_oauth', '', { ...cookieOptions, maxAge: 0 });
  response.cookies.set('raid_oauth_return', '', { ...cookieOptions, maxAge: 0 });
  return response;
}
export async function disconnect(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    await disconnectX(user.id);
    const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    response.cookies.set('raid_oauth', '', { ...cookieOptions, maxAge: 0 });
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof HttpError ? error.message : 'Could not disconnect X. Try again.' },
      { status: error instanceof HttpError ? error.status : 500 },
    );
  }
}
