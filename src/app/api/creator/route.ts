import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, HttpError } from '@/lib/auth';
import { db } from '@/lib/db';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser();
    const { affiliation } = await request.json();
    if (
      typeof affiliation !== 'string' ||
      affiliation.trim().length < 20 ||
      affiliation.length > 1000
    )
      throw new HttpError(400, 'Describe your project affiliation in 20–1,000 characters.');
    await db.user.update({ where: { id: user.id }, data: { affiliation: affiliation.trim() } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
