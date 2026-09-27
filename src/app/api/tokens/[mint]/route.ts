import { NextResponse } from 'next/server';
import { getToken } from '@/lib/data';
import { failure } from '@/lib/http';
export async function GET(_: Request, { params }: { params: Promise<{ mint: string }> }) {
  try {
    const token = await getToken((await params).mint);
    return NextResponse.json(token || { error: 'Token not found' }, { status: token ? 200 : 404 });
  } catch (e) {
    return failure(e);
  }
}
