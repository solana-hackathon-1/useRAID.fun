import Link from 'next/link';
import { loadTrackingOps } from '@/lib/tracking-ops';
import { formatUtcDateTime } from '@/lib/format';
import { AdminAction } from './admin';
import { trackingEnabled, trackingSettlementEnabled } from '@/lib/config';
export async function TrackingOperations() {
  const {
    raids,
    raidCount,
    held,
    carryTargets,
    needsReview,
    needsReviewCount,
    history,
    historyCount,
    disputes,
    disputeCount,
    endpoints,
    stale,
    backlog,
  } = await loadTrackingOps();
  const decision = (p: (typeof needsReview)[number]) => (
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
  );
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
          {e.key} · last success {e.lastSuccessAt ? formatUtcDateTime(e.lastSuccessAt) : 'never'} ·
          remaining {e.remaining ?? 'unknown'} · reset{' '}
          {e.resetAt ? formatUtcDateTime(e.resetAt) : 'unknown'} {e.lastError}
        </p>
      ))}
      <h3>
        Finalization and held funds ({raidCount}
        {raidCount > raids.length ? `, showing ${raids.length}` : ''})
      </h3>
      {raids.map((r) => (
        <div className="admin-row" key={r.id}>
          <Link className="inline-link" href={`/raids/${r.id}`}>
            {r.title}
          </Link>
          <p>
            {r.trackingPhase} · {r.coverage} · {r.collectionError || 'No provider error'} · review{' '}
            {r.reviewEndsAt ? formatUtcDateTime(r.reviewEndsAt) : 'not started'}
          </p>
          {r.trackingPhase === 'HELD' && (
            <p>
              Held gross:{' '}
              {held.find((h) => h.raidId === r.id)?._sum.grossLamports?.toString() || '0'} lamports.
              No allocation or transfer authorized.
            </p>
          )}
          {r.holdReason === 'COVERAGE_EXPIRED' && (
            <AdminAction
              url={`/api/raids/${r.id}/resolve`}
              action="tracking"
              id={r.id}
              label="Accept partial search coverage and finalize"
              values={{ action: 'accept-coverage' }}
            />
          )}
          {r.trackingPhase === 'HELD' &&
            carryTargets
              .filter((target) => target.id !== r.id && target.tokenLaunchId === r.tokenLaunchId)
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
      <h3>
        Needs review ({needsReviewCount}
        {needsReviewCount > needsReview.length ? `, showing ${needsReview.length}` : ''})
      </h3>
      {!needsReview.length && <p>No contributions need a decision.</p>}
      {needsReview.map(decision)}
      <details>
        <summary>Excluded / unavailable ({historyCount})</summary>
        {historyCount > history.length && (
          <p className="small-print">Showing the {history.length} most recently observed.</p>
        )}
        {history.map(decision)}
      </details>
      <h3>Open disputes ({disputeCount})</h3>
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
