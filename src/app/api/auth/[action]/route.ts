import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createHash } from 'node:crypto';
import { reserveUsage } from '@/lib/providers/x';
import { db } from '@/lib/db';
import { config } from '@/lib/config';
import { random, hash, cookieOptions, checkOrigin, clientKey, rateLimit } from '@/lib/auth';
export async function GET(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (config.demo || !process.env.X_CLIENT_ID)
    return NextResponse.redirect(new URL('/creator?auth=unavailable', config.appUrl));
  try {
    await rateLimit(`oauth:${clientKey(request)}`, 30, 600);
    const jar = await cookies();
    const callback = new URL('/api/auth/callback', config.appUrl).toString();
    if (action === 'login') {
      const state = random(),
        verifier = random();
      await db.oAuthAttempt.create({
        data: { stateHash: hash(state), verifier, expiresAt: new Date(Date.now() + 600000) },
      });
      jar.set('raid_oauth', state, { ...cookieOptions, maxAge: 600 });
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: process.env.X_CLIENT_ID,
        redirect_uri: callback,
        scope: 'tweet.read users.read',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      return NextResponse.redirect(`https://x.com/i/oauth2/authorize?${query}`);
    }
    if (action === 'callback') {
      const url = new URL(request.url),
        state = url.searchParams.get('state'),
        code = url.searchParams.get('code');
      if (!state || !code || state !== jar.get('raid_oauth')?.value)
        throw new Error('Invalid OAuth state');
      const attempt = await db.oAuthAttempt.delete({ where: { stateHash: hash(state) } });
      jar.delete('raid_oauth');
      if (attempt.expiresAt < new Date()) throw new Error('Expired OAuth attempt');
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (process.env.X_CLIENT_SECRET)
        headers.Authorization = `Basic ${Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64')}`;
      const token = await fetch('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: process.env.X_CLIENT_ID,
          code,
          redirect_uri: callback,
          code_verifier: attempt.verifier,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!token.ok) throw new Error('Token exchange failed');
      const credentials = await token.json();
      await reserveUsage(1, undefined, true);
      const me = await fetch('https://api.x.com/2/users/me', {
        headers: { Authorization: `Bearer ${credentials.access_token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!me.ok) throw new Error('Identity lookup failed');
      const { data } = await me.json();
      if (!data?.id || !data?.username) throw new Error('Missing X identity');
      const admin = (process.env.ADMIN_X_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .includes(data.id);
      const user = await db.user.upsert({
        where: { xId: data.id },
        create: {
          xId: data.id,
          handle: data.username,
          role: admin ? 'ADMIN' : 'CREATOR',
          approved: admin,
        },
        update: { handle: data.username, ...(admin ? { role: 'ADMIN' } : {}) },
      });
      if (user.suspended) throw new Error('Account suspended');
      const session = random();
      await db.session.create({
        data: {
          tokenHash: hash(session),
          userId: user.id,
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
      });
      jar.set('raid_session', session, { ...cookieOptions, maxAge: 7 * 86400 });
      return NextResponse.redirect(new URL('/creator', config.appUrl));
    }
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch {
    return NextResponse.redirect(new URL('/creator?auth=failed', config.appUrl));
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    checkOrigin(request);
    if ((await params).action !== 'logout')
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const jar = await cookies(),
      token = jar.get('raid_session')?.value;
    if (token) await db.session.deleteMany({ where: { tokenHash: hash(token) } });
    jar.delete('raid_session');
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Request rejected' }, { status: 403 });
  }
}
