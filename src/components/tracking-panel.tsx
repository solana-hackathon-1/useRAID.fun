'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { TrackingView } from '@/lib/tracking-view';
import { SubmitPost } from './actions';
import { WalletLogin } from './wallet-login';
import { formatUsdc } from '@/lib/usdc-amount';
export function TrackingPanel({
  raidId,
  view,
  walletAddress,
  xConnected,
}: {
  raidId: string;
  view: TrackingView;
  walletAddress: string | null;
  xConnected: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function send(path: string, body: unknown = {}) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/raids/${raidId}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Request failed.');
      setMessage(
        path === 'enroll'
          ? 'Joined. Posts created from now on can qualify.'
          : 'Dispute recorded. Results remain under review.',
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Raid contributions</h2>
      <p>
        {view.impressions.total.toLocaleString()} observed impressions
        {view.impressionTarget ? ` / ${view.impressionTarget.toLocaleString()} target` : ''}
        {view.impressions.missing
          ? ` · Views unavailable for ${view.impressions.missing} qualifying posts`
          : ''}
      </p>
      {view.impressionTarget && (
        <progress
          max={view.impressionTarget}
          value={Math.min(view.impressions.total, view.impressionTarget)}
          aria-label="Impression target progress"
        />
      )}
      {view.targetReachedAt && (
        <p className="notice">
          Impression target reached. Campaign ended; final metrics and review follow.
        </p>
      )}
      <p role="status">
        {view.health} · {view.phase.replaceAll('_', ' ')}
      </p>
      <p className="small-print">
        Join before posting. Original posts and quotes must include @{view.officialHandle}
        {view.ruleVersion >= 3
          ? ` in your own text.${view.ruleVersion >= 4 ? ' Quote or link a listed target post.' : ''} If you joined overlapping Raids, submit the post URL here to choose one.`
          : ' and this Raid’s hashtag in your own text.'}{' '}
        Your best 10 posts count toward Attention.{' '}
        {view.currency === 'USDC'
          ? 'All qualifying contributor views determine USDC rewards, not Attention score. Payments follow operator approval.'
          : 'Automated rewards are coming soon.'}{' '}
        Results follow collection and a two-hour review.
      </p>
      {view.resultVersion && (
        <p>
          Result version {view.resultVersion} ·{' '}
          {view.reviewEndsAt ? `Review deadline: ${new Date(view.reviewEndsAt).toISOString()}` : ''}
        </p>
      )}
      {view.phase === 'HELD' && (
        <p className="notice">
          Funds held for administrator resolution:{' '}
          {view.holdReason?.replaceAll('_', ' ').toLowerCase()}.
        </p>
      )}
      {view.canJoin && (
        <>
          <WalletLogin currentAddress={walletAddress} />
          {!xConnected && (
            <Link className="inline-link" href="/api/auth/x">
              Connect X
            </Link>
          )}
          <button
            className="button"
            disabled={busy || !walletAddress || !xConnected}
            onClick={() => void send('enroll')}
          >
            Join Raid
          </button>
        </>
      )}
      {view.enrollment && (
        <p className="small-print">
          Joined {view.enrollment.joinedAt} · Verified participant wallet:{' '}
          <span className="mint">{view.enrollment.walletAddress}</span>
        </p>
      )}
      {view.ownAllocations.length > 0 && (
        <div>
          <h3>Your finalized allocation</h3>
          {view.ownAllocations.map((allocation, i) => (
            <p key={i}>
              {allocation.kind === 'REFUND' ? 'Creator refund' : 'Raider reward'}:{' '}
              {(Number(allocation.lamports) / 1e9).toFixed(6)} SOL · {allocation.status}
              {allocation.signature && (
                <>
                  {' '}
                  ·{' '}
                  <a
                    className="inline-link"
                    href={`https://solscan.io/tx/${allocation.signature}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Payment receipt
                  </a>
                </>
              )}
            </p>
          ))}
        </div>
      )}
      {view.canSubmit && (
        <SubmitPost
          id={raidId}
          demo={false}
          ruleVersion={view.ruleVersion}
          officialHandle={view.officialHandle}
        />
      )}
      {view.ownUsdcPayments.length > 0 && (
        <div>
          <h3>Your finalized USDC reward</h3>
          {view.ownUsdcPayments.map((t) => (
            <p key={t.id}>
              {formatUsdc(t.amount)} USDC ·{' '}
              {t.status === 'PAID' ? 'Paid' : 'Operator payment pending'}
              {t.signature && t.network !== 'sandbox' && (
                <>
                  {' '}
                  ·{' '}
                  <a
                    className="inline-link"
                    href={`https://solscan.io/tx/${t.signature}${t.network === 'devnet' ? '?cluster=devnet' : ''}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Receipt
                  </a>
                </>
              )}
            </p>
          ))}
        </div>
      )}
      {view.enrollment && (
        <>
          <h3>Your contributions</h3>
          <p>
            {view.ownContributions.filter((p) => p.qualification === 'QUALIFIED').length}/
            {view.ownContributions.length} qualified ·{' '}
            {view.ownContributions.filter((p) => p.scored).length}/10 scored
          </p>
          {view.ownContributions.map((p) => (
            <div className="admin-row" key={p.id}>
              <a
                className="inline-link"
                href={`https://x.com/i/web/status/${p.id}`}
                target="_blank"
                rel="noreferrer"
              >
                Post {p.id}
              </a>
              <p>
                {p.qualification} ·{' '}
                {p.reviewStatus === 'FLAGGED'
                  ? 'Awaiting review'
                  : p.scored
                    ? `${p.score.toFixed(2)} Attention`
                    : 'Not scored'}
                {p.reasonCode ? ` · ${p.reasonCode.replaceAll('_', ' ')}` : ''}
              </p>
              <small>
                {p.availability} · Metrics observed {p.observedAt || 'not yet'}
              </small>
            </div>
          ))}
          {view.submissions
            .filter((s) => !view.ownContributions.some((p) => p.id === s.postId))
            .map((s) => (
              <p key={s.id}>
                Post {s.postId}: {s.status} {s.reasonCode?.replaceAll('_', ' ')}
              </p>
            ))}
        </>
      )}
      <h3>Raider leaderboard</h3>
      {!view.leaderboard.length && <p>No scored contributions yet.</p>}
      {view.leaderboard.map((a, i) => (
        <div className="admin-row" key={a.xId}>
          <strong>
            #{i + 1} @{a.handle} — {a.score.toLocaleString()} Attention
          </strong>
          <p>
            {a.qualifiedPosts} qualified posts · {a.scoredPostIds.length} scored
            {view.currency === 'USDC' && (
              <>
                {' '}
                · {a.views.toLocaleString()} observed impressions ·{' '}
                {a.estimatedUsdc === null
                  ? 'Reward estimate unavailable'
                  : `${formatUsdc(a.estimatedUsdc)} USDC estimated (subject to final review)`}
              </>
            )}
          </p>
        </div>
      ))}
      <h3>Top posts</h3>
      {view.topPosts.map((p) => (
        <p key={p.id}>
          <a
            className="inline-link"
            href={`https://x.com/i/web/status/${p.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Post {p.id}
          </a>{' '}
          — {p.score.toFixed(2)} Attention <small>· observed {p.observedAt}</small>
          <br />
          <small>
            {p.views === null ? 'Views unavailable' : `${p.views.toLocaleString()} views`} ·{' '}
            {p.likes} likes · {p.replies} replies · {p.reposts} reposts · {p.quotes} quotes
          </small>
        </p>
      ))}
      {view.enrollment &&
        view.phase === 'REVIEW' &&
        view.reviewEndsAt &&
        Date.parse(view.reviewEndsAt) > Date.now() && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void send('disputes', {
                category: form.get('category'),
                reason: form.get('reason'),
                ...(form.get('postId') ? { postId: form.get('postId') } : {}),
              });
            }}
          >
            <h3>Report a result issue</h3>
            <label className="field">
              Issue
              <select name="category">
                <option value="MISSING_POST">Missing post</option>
                <option value="EXCLUSION">Wrong exclusion</option>
                <option value="METRICS">Metrics</option>
                <option value="IDENTITY">Identity</option>
              </select>
            </label>
            <label className="field">
              Post ID (optional)
              <input name="postId" pattern="[0-9]+" />
            </label>
            <label className="field">
              Reason
              <textarea name="reason" required maxLength={2000} />
            </label>
            <button className="button secondary" disabled={busy}>
              Submit dispute
            </button>
          </form>
        )}
      {view.disputes.map((d) => (
        <p key={d.id}>
          {d.category.replaceAll('_', ' ')}: {d.status} · {d.resolution || d.reason}
        </p>
      ))}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
