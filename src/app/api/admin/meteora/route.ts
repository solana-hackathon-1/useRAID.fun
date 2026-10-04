import { NextResponse } from 'next/server';
import { checkOrigin, requireUser, rateLimit } from '@/lib/auth';
import { approveLaunchPayout } from '@/lib/meteora/campaigns';
import { meteoraNetwork, meteoraReadiness } from '@/lib/meteora/config';
import { db } from '@/lib/db';
import { failure, readJson } from '@/lib/http';
import { z } from 'zod';
export async function GET() {
  try {
    await requireUser(true);
    const [payouts, launches] = await Promise.all([
      db.launchCampaignPayout.findMany({
        where: { network: meteoraNetwork(), status: { not: 'PAID' } },
        include: { launch: { select: { symbol: true, mint: true } } },
        take: 100,
        orderBy: { id: 'asc' },
      }),
      db.tokenLaunch.findMany({
        where: { provider: 'METEORA', network: meteoraNetwork() },
        select: { id: true, name: true, status: true, error: true, workerObservedAt: true },
        take: 50,
      }),
    ]);
    return NextResponse.json(
      {
        readiness: meteoraReadiness(),
        launches,
        payouts: payouts.map((p) => ({ ...p, units: p.units.toString() })),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const user = await requireUser(true);
    await rateLimit(`meteora-admin:${user.id}`, 30, 60);
    const body = await readJson(
      request,
      z.object({
        id: z.string().min(1),
        action: z.enum(['approve', 'hold']),
        reason: z.string().max(2000).default(''),
      }),
    );
    await approveLaunchPayout(body.id, user.id, body.action === 'approve', body.reason);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
