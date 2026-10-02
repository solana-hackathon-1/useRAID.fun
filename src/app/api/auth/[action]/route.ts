import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { hash, checkOrigin } from '@/lib/auth';
import { failure } from '@/lib/http';
import { sessionCookie } from '@/lib/studio-mode';
export async function GET(_request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action === 'login' || action === 'callback')
    return new NextResponse(null, {
      status: 303,
      headers: {
        Location: action === 'login' ? '/api/auth/x' : '/creator?auth=state',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    checkOrigin(request);
    if ((await params).action !== 'logout')
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const jar = await cookies(),
      token = jar.get(sessionCookie())?.value;
    if (token) await db.session.deleteMany({ where: { tokenHash: hash(token) } });
    jar.delete(sessionCookie());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
