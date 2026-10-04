import { NextResponse } from 'next/server';
import { meteoraReadiness } from '@/lib/meteora/config';
import { failure } from '@/lib/http';
export async function GET() {
  try { return NextResponse.json(meteoraReadiness(),{headers:{'Cache-Control':'no-store'}}); } catch(e){return failure(e);}
}
