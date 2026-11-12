import { NextResponse } from 'next/server';
import { deploymentEnvironment } from '@/lib/deployment-environment';
export const dynamic = 'force-dynamic';
/** The validated deployment label and network only (no secrets, no database): lets the root error page show it. */
export async function GET() {
  const { production, declared, label, network } = deploymentEnvironment();
  return NextResponse.json(
    { production, declared, label, network },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
