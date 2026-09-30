import Link from 'next/link';
import { db } from '@/lib/db';
import { AdminAction } from './admin';
import { trackingEnabled, trackingSettlementEnabled } from '@/lib/config';
export async function TrackingOperations() {
  const [raids, flags, disputes, endpoints, stale, backlog] = await Promise.all([
    db.raid.findMany({
      where: { trackingVersion: 2, trackingPhase: { not: 'ALLOCATED' } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),
    db.post.findMany({
      where: {
        raid: { trackingVersion: 2 },
        OR: [
          { reviewStatus: 'FLAGGED' },
          { qualification: 'EXCLUDED' },
          { availability: { not: 'AVAILABLE' } },
        ],
      },
      take: 50,
    }),
    db.raidDispute.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'asc' }, take: 50 }),
    db.xEndpointState.findMany(),
    db.post.count({
      where: {
        raid: { trackingVersion: 2, status: 'ACTIVE' },
        observedAt: { lt: new Date(Date.now() - 600000) },
      },
    }),
    db.job.count({ where: { doneAt: null } }),
  ]);
  const held = await db.feeClaim.groupBy({
    by: ['raidId'],
    where: {
      roundId: null,
      raidId: { in: raids.filter((r) => r.trackingPhase === 'HELD').map((r) => r.id) },
    },
    _sum: { grossLamports: true, costLamports: true },
  });
  return (
    <section className="panel" id="tracking">
      <h2>X tracking operations</h2>
      <p>
        New tracking: {trackingEnabled() ? 'enabled' : 'paused'} · Reviewed payouts:{' '}
        {trackingSettlementEnabled() ? 'enabled' : 'paused'} · {backlog} pending jobs · {stale}{' '}
        stale active posts
      </p>
      {endpoints.map((e) => (
        <p key={e.key}>
          {e.key} · last success {e.lastSuccessAt?.toISOString() || 'never'} · remaining{' '}
          {e.remaining ?? 'unknown'} · reset {e.resetAt?.toISOString() || 'unknown'} {e.lastError}
        </p>
      ))}
      <h3>Finalization and held funds</h3>
      {raids.map((r) => (
        <div className="admin-row" key={r.id}>
          <Link className="inline-link" href={`/raids/${r.id}`}>
            {r.title}
          </Link>
          <p>
            {r.trackingPhase} · {r.coverage} · {r.collectionError || 'No provider error'} · review{' '}
            {r.reviewEndsAt?.toISOString() || 'not started'}
          </p>
          {r.trackingPhase === 'HELD' && (
            <p>
              Held gross:{' '}
              {held.find((h) => h.raidId === r.id)?._sum.grossLamports?.toString() || '0'} lamports.
              No allocation or transfer authorized.
            </p>
          )}
          {r.trackingPhase === 'HELD' &&
            raids
              .filter(
                (target) =>
                  target.id !== r.id &&
                  target.tokenLaunchId &&
                  target.tokenLaunchId === r.tokenLaunchId &&
                  target.status === 'ACTIVE',
              )
              .map((target) => (
                <AdminAction
                  key={target.id}
                  url={`/api/raids/${r.id}/resolve`}
                  action="tracking"
                  id={r.id}
                  label={`Assign held fees to ${target.title}`}
                  values={{ action: 'carry-held', targetRaidId: target.id }}
                />
              ))}
        </div>
      ))}
      <h3>Contribution decisions</h3>
      {flags.map((p) => (
        <div className="admin-row" key={p.id}>
          <p>
            Post {p.id} · {p.qualification} · {p.reasonCode} · {p.reviewStatus} · {p.availability}
          </p>
          {(['clear', 'exclude', 'restore', 'refresh'] as const).map((action) => (
            <AdminAction
              key={action}
              url={`/api/raids/${p.raidId}/resolve`}
              action="tracking"
              id={p.id}
              label={`${action} post ${p.id}`}
              values={{ action, postId: p.id }}
            />
          ))}
        </div>
      ))}
      <h3>Open disputes</h3>
      {disputes.map((d) => (
        <div className="admin-row" key={d.id}>
          <strong>
            {d.category} · {d.postId || 'Identity / general'}
          </strong>
          <p>{d.reason}</p>
          {d.postId && (
            <AdminAction
              url={`/api/raids/${d.raidId}/resolve`}
              action="tracking"
              id={d.id}
              label="Refresh disputed metrics"
              values={{ action: 'refresh', postId: d.postId }}
            />
          )}
          {d.postId && (
            <AdminAction
              url={`/api/raids/${d.raidId}/resolve`}
              action="tracking"
              id={d.id}
              label="Import missing post"
              values={{ action: 'import-post', disputeId: d.id }}
            />
          )}
          <AdminAction
            url={`/api/raids/${d.raidId}/resolve`}
            action="tracking"
            id={d.id}
            label="Resolve after correction"
            values={{ action: 'resolve-dispute', disputeId: d.id }}
          />
          <AdminAction
            url={`/api/raids/${d.raidId}/resolve`}
            action="tracking"
            id={d.id}
            label="Reject dispute"
            values={{ action: 'reject-dispute', disputeId: d.id }}
          />
        </div>
      ))}
    </section>
  );
}
