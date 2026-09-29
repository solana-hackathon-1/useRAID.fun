import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from './db';
import {
  hash,
  cookieOptions,
  checkOrigin,
  requireUser,
  rateLimit,
  clientKey,
  HttpError,
} from './auth';
import {
  OAuthError,
  oauthConfig,
  startAttempt,
  validState,
  claimAttempt,
  fetchXIdentity,
  completeConnection,
  disconnectX,
} from './x-oauth';

function result(status: string) {
  // Relative fixed destinations cannot inherit an attacker-controlled Host or return URL.
  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: `/creator?auth=${status}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
export async function startX(request: Request) {
  try {
    oauthConfig();
    await rateLimit(`oauth:${clientKey(request)}`, 30, 600);
    const jar = await cookies();
    const raw = jar.get('raid_session')?.value;
    const attempt = await startAttempt(raw ? hash(raw) : null);
    const response = NextResponse.redirect(attempt.url);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.cookies.set('raid_oauth', attempt.state, { ...cookieOptions, maxAge: 600 });
    return response;
  } catch (error) {
    const response = result(error instanceof OAuthError ? error.code : 'failed');
    if (error instanceof OAuthError && error.code === 'session')
      response.cookies.set('raid_session', '', { ...cookieOptions, maxAge: 0 });
    return response;
  }
}
export async function callbackX(request: Request) {
  const jar = await cookies();
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  let claimed = false;
  let response: NextResponse;
  try {
    if (!validState(state, jar.get('raid_oauth')?.value)) throw new OAuthError('state');
    const raw = jar.get('raid_session')?.value;
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
    response = result('connected');
    response.cookies.set('raid_session', token, { ...cookieOptions, maxAge: 7 * 86400 });
  } catch (error) {
    response = result(error instanceof OAuthError ? error.code : 'failed');
  } finally {
    if (claimed)
      await db.oAuthAttempt.deleteMany({ where: { stateHash: hash(state!) } }).catch(() => {});
  }
  response.cookies.set('raid_oauth', '', { ...cookieOptions, maxAge: 0 });
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
