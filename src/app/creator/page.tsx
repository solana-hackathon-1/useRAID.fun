import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { StudioHome } from '@/components/studio-home';
import { StudioAccess } from '@/components/studio-access';
import { balance } from '@/lib/usdc';
import { observedImpressions } from '@/lib/raid-progress';
import { displayIdentity } from '@/lib/token-identity';
export const dynamic = 'force-dynamic';
export default async function CreatorPage({
  searchParams,
}: {
  searchParams: Promise<{ auth?: string }>;
}) {
  const user = await currentUser(),
    { auth } = await searchParams;
  if (!user) return <StudioAccess auth={auth} />;
  const [funds, raids] = await Promise.all([
    balance(user.id),
    db.raid.findMany({
      where: { creatorId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        token: true,
        posts: {
          select: {
            views: true,
            qualification: true,
            availability: true,
            reviewStatus: true,
            hidden: true,
            deleted: true,
          },
        },
        _count: { select: { enrollments: true } },
        usdcAllocations: { select: { id: true } },
        allocations: { select: { paidAt: true } },
      },
    }),
  ]);
  const payments = await db.usdcTransfer.findMany({
    where: { allocationId: { in: raids.flatMap((r) => r.usdcAllocations.map((a) => a.id)) } },
    select: { allocationId: true, status: true },
  });
  return (
    <StudioHome
      auth={auth}
      approved={user.approved}
      affiliation={user.affiliation || ''}
      available={funds.available.toString()}
      reserved={funds.reserved.toString()}
      raids={raids.map((r) => ({
        id: r.id,
        title: r.title,
        symbol: displayIdentity(r).symbol,
        imageUri: displayIdentity(r).imageUri,
        status: r.status,
        phase: r.trackingPhase,
        pool: r.studioVersion === 1 ? r.poolUnits?.toString() || null : r.fundingLamports,
        currency: r.fundingAsset,
        views: observedImpressions(r.posts).total,
        target: r.impressionTarget,
        raiders: r._count.enrollments,
        endsAt: r.endsAt.toISOString(),
        hoursLeft: Math.max(0, Math.ceil((+r.endsAt - Date.now()) / 3600000)),
        legacy: r.studioVersion !== 1,
        paid:
          r.trackingPhase === 'ALLOCATED' &&
          (r.studioVersion === 1
            ? r.usdcAllocations.every((a) =>
                payments.some((p) => p.allocationId === a.id && p.status === 'PAID'),
              )
            : r.allocations.every((a) => a.paidAt !== null)),
      }))}
    />
  );
}
