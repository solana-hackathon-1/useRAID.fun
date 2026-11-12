import { NextResponse } from 'next/server';
import { deploymentEnvironment } from '@/lib/deployment-environment';
export const dynamic = 'force-dynamic';
/** The validated deployment label only (no secrets, no database): lets the root error page show it. */
export async function GET() {
  const { production, declared, label } = deploymentEnvironment();
  return NextResponse.json(
    { production, declared, label },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
