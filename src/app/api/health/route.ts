import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { config } from '@/lib/config';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    if (!config.demo) await db.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: 'ok',
      mode: config.demo ? 'demo' : 'live',
      rateLimitMode: process.env.TRUSTED_IP_HEADER ? 'per-client' : 'shared',
    });
  } catch {
    return NextResponse.json({ status: 'unavailable' }, { status: 503 });
  }
}
