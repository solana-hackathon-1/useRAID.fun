import { NextResponse } from 'next/server';
import { getRaids, aggregateFreshness } from '@/lib/data';
import { failure } from '@/lib/http';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const raids = await getRaids();
    return NextResponse.json({
      raids,
      servedAt: new Date().toISOString(),
      ...aggregateFreshness(raids),
    });
  } catch (e) {
    return failure(e);
  }
}
