import { NextResponse } from 'next/server';
import { meteoraReadiness } from '@/lib/meteora/config';
import { publicRateLimit } from '@/lib/auth';
import { failure } from '@/lib/http';
export async function GET(request: Request) {
  try {
    await publicRateLimit(request, 'launch-config', 120, 60, 6000);
    return NextResponse.json(meteoraReadiness(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return failure(e);
  }
}
