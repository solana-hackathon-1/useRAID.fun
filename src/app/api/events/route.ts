import { NextResponse } from 'next/server';
import { checkOrigin, publicRateLimit, HttpError } from '@/lib/auth';
import { db } from '@/lib/db';
import { failure } from '@/lib/http';
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await publicRateLimit(request, 'event', 60, 60, 1200);
    const b = await request.json();
    if (
      !['discovery_view', 'raid_view', 'share_click', 'trade_click', 'raid_click'].includes(b.type)
    )
      throw new HttpError(400, 'Invalid event');
    if (b.visitor && !/^[a-f0-9-]{36}$/.test(b.visitor))
      throw new HttpError(400, 'Invalid visitor');
    await db.event.create({
      data: {
        type: b.type,
        raidId: typeof b.raidId === 'string' ? b.raidId.slice(0, 80) : null,
        visitor: b.visitor || null,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
