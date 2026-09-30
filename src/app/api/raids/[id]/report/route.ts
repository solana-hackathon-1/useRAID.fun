import { getRaid } from '@/lib/data';
import { trackingView } from '@/lib/tracking-view';
import { failure } from '@/lib/http';
import { config } from '@/lib/config';
import { db } from '@/lib/db';
const csv = (value: unknown) => {
  const text = String(value ?? '');
  return `"${(/^[=+@\-\t\r\n]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
};
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const raid = await getRaid((await params).id);
    if (!raid || config.demo)
      return Response.json({ error: 'Public Raid not found.' }, { status: 404 });
    const tracking = raid.trackingVersion === 2 ? await trackingView(raid.id) : null;
    const funding = await db.raid.findUnique({
      where: { id: raid.id },
      select: { fundingLamports: true, fundingAsset: true, poolUnits: true, studioVersion: true },
    });
    const qualifiedActions =
      tracking?.leaderboard.reduce((sum, member) => sum + member.qualifiedPosts, 0) || 0;
    const earnedSol =
      funding?.fundingLamports && tracking?.impressionTarget
        ? ((Number(funding.fundingLamports) / 1e9) *
            Math.min(tracking.impressions.total, tracking.impressionTarget)) /
          tracking.impressionTarget
        : null;
    const reviewed =
      !!tracking?.resultVersion &&
      ['APPROVED', 'ALLOCATED'].includes(tracking.phase) &&
      !tracking.impressions.missing;
    const earnedUsdc =
      funding?.poolUnits && tracking?.impressionTarget && reviewed
        ? ((Number(funding.poolUnits) / 1e6) *
            Math.min(tracking.impressions.total, tracking.impressionTarget)) /
          tracking.impressionTarget
        : null;
    const rows: unknown[][] = [
      ['Campaign report', raid.title],
      ['Raid ID', raid.id],
      ['Project', raid.name],
      ['Token mint', raid.mint || 'No token'],
      ['Status', raid.status],
      ['Start', raid.startsAt],
      ['End', raid.endsAt],
      ['Generated at', new Date().toISOString()],
      ['Data status', tracking?.health || raid.freshness],
      ['Review status', tracking?.phase || 'Legacy'],
      ['Result version', tracking?.resultVersion || 'Live — provisional'],
      ['Attention score', raid.score],
      ['Raider count', raid.raiders],
      ['Qualifying posts', raid.posts],
      ['Interactions', raid.interactions],
      ['Observed impressions', tracking?.impressions.total ?? 'Unavailable'],
      ['Posts with unavailable views', tracking?.impressions.missing ?? 'Unavailable'],
      ['Impression target', tracking?.impressionTarget || 'None'],
      ['Target reached', tracking?.targetReachedAt || 'No'],
      [
        'Content CPA (SOL per qualifying post)',
        earnedSol !== null && qualifiedActions
          ? (earnedSol / qualifiedActions).toFixed(8)
          : 'Unavailable',
      ],
      ['Reward currency', funding?.fundingAsset || 'SOL'],
      ['USDC reward pool', funding?.poolUnits ? Number(funding.poolUnits) / 1e6 : 'Not applicable'],
      [
        'Content CPA (reviewed USDC per qualifying post)',
        earnedUsdc !== null && qualifiedActions
          ? (earnedUsdc / qualifiedActions).toFixed(6)
          : 'Unavailable — requires reviewed results and complete views',
      ],
      [
        'Reviewed USDC CPM',
        earnedUsdc !== null && tracking?.impressions.total
          ? ((earnedUsdc * 1000) / tracking.impressions.total).toFixed(6)
          : 'Unavailable',
      ],
      [],
      ['Rank', 'X handle', 'Score', 'Qualified posts', 'Scored posts'],
      ...(tracking?.leaderboard.map((member, i) => [
        i + 1,
        member.handle,
        member.score,
        member.qualifiedPosts,
        member.scoredPostIds.length,
      ]) || []),
      [],
      ['Post', 'Views', 'Likes', 'Replies', 'Reposts', 'Quotes', 'Observed at'],
      ...(tracking?.topPosts.map((post) => [
        `https://x.com/i/web/status/${post.id}`,
        post.views ?? 'Unavailable',
        post.likes,
        post.replies,
        post.reposts,
        post.quotes,
        post.observedAt,
      ]) || []),
    ];
    return new Response(rows.map((row) => row.map(csv).join(',')).join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="raid-report.csv"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return failure(error);
  }
}
