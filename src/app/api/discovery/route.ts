import { NextResponse } from 'next/server';
import { getRaids, aggregateFreshness } from '@/lib/data';
import { publicRateLimit } from '@/lib/auth';
import { failure } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    await publicRateLimit(request, 'discovery', 120, 60, 6000);
    const raids = await getRaids();
    return NextResponse.json(
      {
        raids,
        servedAt: new Date().toISOString(),
        ...aggregateFreshness(raids),
      },
      { headers: { 'Cache-Control': 'public, max-age=10' } },
    );
  } catch (e) {
    return failure(e);
  }
}
