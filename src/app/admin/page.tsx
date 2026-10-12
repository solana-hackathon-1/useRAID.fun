import { TrackingOperations } from '@/components/tracking-operations';
import { oauthMessage } from '@/lib/oauth-messages';
import { XDiagnostics } from '@/components/x-diagnostics';
import { adminUser } from '@/lib/auth';
import { adminXIds } from '@/lib/admins';
import { returningVisitors } from '@/lib/data';
import { config } from '@/lib/config';
import { db } from '@/lib/db';
import { AdminAction, SettingsForm } from '@/components/admin';
import { AdminPaymentForm } from '@/components/raid-tools';
import { fundingPricing } from '@/lib/raid-funding';
import { launchpadsAvailable } from '@/lib/release';
import { JOB_MAX_ATTEMPTS } from '@/lib/queue';
import { UsdcPaymentForm } from '@/components/usdc-operations';
import { reconcileUsdc } from '@/lib/usdc-reconcile';
import { formatUsdc, studioSandbox, usdcSettings } from '@/lib/usdc';
import { formatNumber, formatUtcDateTime } from '@/lib/format';
import {
  ADMIN_PAGE,
  adminListArgs,
  adminPageNumber,
  type AdminListParams,
} from '@/lib/admin-lists';
import Link from 'next/link';
export const dynamic = 'force-dynamic';
function Pager({
  param,
  page,
  hasNext,
  params,
  anchor,
}: {
  param: keyof AdminListParams;
  page: number;
  hasNext: boolean;
  params: AdminListParams;
  anchor: string;
}) {
  if (page === 1 && !hasNext) return null;
  const href = (to: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, [param]: to > 1 ? String(to) : '' }))
      if (value && key !== 'auth') query.set(key, value);
    return `/admin${query.size ? `?${query}` : ''}#${anchor}`;
  };
  return (
    <nav className="pager" aria-label={`${anchor} pages`}>
      {page > 1 ? <Link href={href(page - 1)}>Previous</Link> : <span />}
      <span>Page {page}</span>
      {hasNext ? <Link href={href(page + 1)}>Next</Link> : <span />}
    </nav>
  );
}
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ auth?: string } & AdminListParams>;
}) {
  const [user, { auth, ...params }] = await Promise.all([adminUser(), searchParams]);
  const authMessage = oauthMessage(auth);
  if (!user)
    return (
      <div className="panel access-card">
        <h1>Operations</h1>
        {authMessage && (
          <p role="alert" className="notice">
            {authMessage}
          </p>
        )}
        <p>
          Administrator access is required to manage creators, moderate campaigns, and control
          collection.
        </p>
        {config.demo ? (
          <div className="notice info">Admin controls are disabled in the read-only preview.</div>
        ) : (
          <a className="button" href="/api/auth/x?return=admin">
            Sign in with X
          </a>
        )}
      </div>
    );
  const now = new Date(),
    month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lists = adminListArgs(params, adminXIds());
  const [settings, allUsers, allRaids, allPosts, jobs, usage, identityUsage, events, audit] =
    await Promise.all([
      db.settings.upsert({ where: { id: 'global' }, create: {}, update: {} }),
      db.user.findMany(lists.users),
      db.raid.findMany(lists.raids),
      db.post.findMany(lists.posts),
      db.job.findMany({
        where: { error: { not: null }, doneAt: null },
        orderBy: { runAt: 'desc' },
        take: 20,
      }),
      db.providerUsage.aggregate({
        where: { provider: 'x', at: { gte: month } },
        _sum: { reservedCents: true },
      }),
      db.providerUsage.aggregate({
        where: { provider: 'x-identity', at: { gte: month } },
        _sum: { reservedCents: true },
      }),
      db.event.groupBy({ by: ['type'], where: { at: { gte: month } }, _count: true }),
      db.moderationEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 15 }),
    ]);
  const [completed, creatorCampaigns, visitors, campaignUsage] = await Promise.all([
    db.raid.count({ where: { status: 'ENDED' } }),
    db.raid.groupBy({
      by: ['creatorId'],
      where: { status: { in: ['ACTIVE', 'ENDED', 'SCHEDULED'] } },
      _count: true,
    }),
    returningVisitors(month),
    db.providerUsage.groupBy({
      by: ['raidId'],
      where: { provider: 'x', at: { gte: month } },
      _sum: { reservedCents: true },
    }),
  ]);
  const usageTitles = new Map(
    (
      await db.raid.findMany({
        where: { id: { in: campaignUsage.flatMap((c) => (c.raidId ? [c.raidId] : [])) } },
        select: { id: true, title: true },
      })
    ).map((r) => [r.id, r.title]),
  );
  const creatorPage = adminPageNumber(params.creatorPage),
    campaignPage = adminPageNumber(params.campaignPage),
    postPage = adminPageNumber(params.postPage);
  const users = allUsers.slice(0, ADMIN_PAGE),
    raids = allRaids.slice(0, ADMIN_PAGE),
    posts = allPosts.slice(0, ADMIN_PAGE);
  const pausedLaunches = await db.tokenLaunch.findMany({
    where: { status: 'PAUSED' },
    select: { id: true, mint: true, name: true, error: true },
    take: 20,
  });
  const [fundingDrafts, allocations] = await Promise.all([
    db.raid.findMany({
      where: { studioVersion: 0, mint: null, status: 'DRAFT', fundingStatus: 'PENDING' },
      include: { creator: true },
      take: 50,
    }),
    db.raidAllocation.findMany({
      where: { paidAt: null },
      include: { raid: true },
      orderBy: { id: 'asc' },
      take: 100,
    }),
  ]);
  const spend = usage._sum.reservedCents || 0,
    signInSpend = identityUsage._sum.reservedCents || 0,
    ratio = (spend + signInSpend) / settings.monthlyBudgetCents;
  const usdcPayments = await db.usdcTransfer.findMany({
    where: { status: 'REQUESTED', kind: { in: ['REWARD', 'WITHDRAWAL'] } },
    orderBy: { createdAt: 'asc' },
    take: 100,
    include: { user: true },
  });
  const expiredDeposits = await db.usdcTransfer.findMany({
    where: { kind: 'DEPOSIT', status: 'AWAITING_TRANSFER', expiresAt: { lt: now } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { user: true },
  });
  const reconciliation = await Promise.race([
    reconcileUsdc().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
  ]);
  return (
    <>
      <div className="page-title">
        <h1>Operations</h1>
        <p>Keep the pilot useful, attributable, and within budget.</p>
      </div>
      <XDiagnostics userId={user.id} />
      <TrackingOperations />
      {!config.liveApproved && (
        <div className="notice">
          Deployment feasibility gate is closed. Live X collection stays disabled regardless of the
          switch below.
        </div>
      )}
      {ratio >= 0.7 && (
        <div className="notice">
          {ratio >= 0.9 ? '90%' : '70%'} budget alert: conservative recorded usage has reached $
          {((spend + signInSpend) / 100).toFixed(2)}.
        </div>
      )}
      <div className="metric-grid">
        <div>
          <span>Recorded X usage ceiling</span>
          <strong>${(spend / 100).toFixed(2)}</strong>
        </div>
        <div>
          <span>Sign-in spend this month</span>
          <strong>${(signInSpend / 100).toFixed(2)}</strong>
        </div>
        <div>
          <span>Monthly budget</span>
          <strong>${settings.monthlyBudgetCents / 100}</strong>
        </div>
        <div>
          <span>Collection state</span>
          <strong>
            {settings.collectionEnabled && config.liveApproved ? 'Enabled' : 'Paused'}
          </strong>
        </div>
        <div>
          <span>Failed jobs shown</span>
          <strong>{jobs.length}</strong>
        </div>
      </div>
      <form method="get" className="search-box" role="search">
        <input
          name="q"
          type="search"
          aria-label="Search operations"
          placeholder="Search creators, campaigns and posts"
          defaultValue={lists.q}
        />
        <button className="button secondary small">Search</button>
      </form>
      <nav className="section-nav" aria-label="Operations sections">
        <a href="#limits">Operating limits</a>
        <a href="#usdc-reconciliation">USDC reconciliation</a>
        <a href="#standalone-funding">Raid funding</a>
        <a href="#finance">Launchpads</a>
        <a href="#creators">Creators</a>
        <a href="#campaigns">Campaigns</a>
        <a href="#posts">Posts</a>
        <a href="#failures">Failures</a>
        <a href="#activity">Activity & audit</a>
      </nav>
      <div className="admin-grid">
        <section className="panel" id="usdc-payments">
          <h2>USDC withdrawals & rewards</h2>
          <p>
            Rate:{' '}
            {usdcSettings().rateUnits
              ? `${formatUsdc(usdcSettings().rateUnits!)} USDC / 1,000 impressions`
              : 'Not configured'}
            . Operator sends transfers manually; platform pays outbound network fees. No transfer is
            sent by this page.
          </p>
          {!usdcPayments.length && <p>No payments awaiting review.</p>}
          {usdcPayments.map((t) => (
            <div className="admin-row" key={t.id}>
              <strong>
                {t.kind} · @{t.user.handle} · {formatUsdc(t.amount)} USDC
              </strong>
              <p>
                {t.network} · Mint: <span className="mint">{t.mint}</span>
              </p>
              <p>
                From platform: <span className="mint">{t.recipient}</span>
                <br />
                To verified wallet: <span className="mint">{t.walletAddress}</span>
                <br />
                Raw units (6 decimals): {t.amount.toString()}
                <br />
                Required memo: <code>useRAID:usdc:{t.id}</code>
              </p>
              <UsdcPaymentForm
                id={t.id}
                withdrawal={t.kind === 'WITHDRAWAL'}
                sandbox={studioSandbox() && t.network === 'sandbox'}
              />
            </div>
          ))}
        </section>
        <section className="panel" id="usdc-reconciliation">
          <h2>USDC reconciliation</h2>
          {!reconciliation ? (
            <p>Reconciliation unavailable.</p>
          ) : (
            <>
              {reconciliation.surplus !== null && reconciliation.surplus < 0n && (
                <div className="notice">
                  Custody wallet is short of recorded liabilities by{' '}
                  {formatUsdc(-reconciliation.surplus)} USDC.
                </div>
              )}
              <p>
                Network: {reconciliation.network}
                <br />
                Ledger liabilities (available + reserved, credits included):{' '}
                {formatUsdc(reconciliation.liabilities)} USDC
                <br />
                Reward transfers awaiting payment: {formatUsdc(reconciliation.pendingRewards)} USDC
                <br />
                Custody wallet balance:{' '}
                {reconciliation.custody === null
                  ? 'Not applicable'
                  : `${formatUsdc(reconciliation.custody)} USDC`}
                <br />
                Surplus:{' '}
                {reconciliation.surplus === null
                  ? 'Not applicable'
                  : `${reconciliation.surplus < 0n ? '-' : ''}${formatUsdc(
                      reconciliation.surplus < 0n
                        ? -reconciliation.surplus
                        : reconciliation.surplus,
                    )} USDC`}
                <br />
                Unconfirmed deposit intents: {reconciliation.unconfirmedDeposits}
              </p>
            </>
          )}
          <h3>Expired deposit intents</h3>
          {!expiredDeposits.length && <p>No expired deposit intents.</p>}
          {expiredDeposits.map((t) => (
            <div className="admin-row" key={t.id}>
              <strong>
                @{t.user.handle} · {formatUsdc(t.amount)} USDC
              </strong>
              <p>
                {t.network} · Required memo: <code>useRAID:usdc:{t.id}</code>
              </p>
              <UsdcPaymentForm id={t.id} withdrawal={false} sandbox={false} late />
            </div>
          ))}
        </section>
        <section className="panel" id="standalone-funding">
          <h2>Non-token Raid funding</h2>
          <p>
            Rate:{' '}
            {fundingPricing()
              ? `${fundingPricing()!.lamportsPerThousand / 1e9} SOL per 1,000 impressions`
              : 'Not configured'}{' '}
            · Funding wallet: {fundingPricing()?.recipient || 'Not configured'}
          </p>
          <p>
            Creator deposits remain platform held until final review. Send each verified allocation
            from funding wallet with exact memo shown below. Record finalized signature after
            transfer.
          </p>
          {fundingDrafts.map((raid) => (
            <div className="admin-row" key={raid.id}>
              <strong>
                {raid.title} · @{raid.creator.handle}
              </strong>
              <p>
                Target: {formatNumber(raid.impressionTarget)} impressions · {raid.fundingRequest}
              </p>
              <p>
                Quote:{' '}
                {raid.fundingLamports
                  ? `${Number(raid.fundingLamports) / 1e9} SOL`
                  : 'Pending price'}
              </p>
              {fundingPricing() && !raid.fundingLamports && (
                <AdminAction
                  action="funding-quote"
                  id={raid.id}
                  label="Issue funding quote"
                  values={{}}
                />
              )}
            </div>
          ))}
          <h3>Payments due</h3>
          {!allocations.length && <p>No reviewed allocations awaiting payment.</p>}
          {allocations.map((allocation) => (
            <div className="admin-row" key={allocation.id}>
              <strong>
                {allocation.kind} · {Number(allocation.lamports) / 1e9} SOL ·{' '}
                {allocation.raid.title}
              </strong>
              <p>
                To: <span className="mint">{allocation.walletAddress}</span>
              </p>
              <p>
                From: <span className="mint">{allocation.raid.fundingRecipient}</span>
              </p>
              <p>
                Memo: <code>useRAID:pay:{allocation.id}</code>
              </p>
              <AdminPaymentForm id={allocation.id} />
            </div>
          ))}
        </section>
        <section className="panel" id="limits">
          <h2>Operating limits</h2>
          <SettingsForm settings={settings} />
        </section>
        <section className="panel" id="finance">
          <h2>Launchpads · Coming soon</h2>
          {launchpadsAvailable && (
            <>
              <p>
                Deployment switches: launches{' '}
                {Reflect.get(process.env, 'LAUNCH_ENABLED') === 'true' ? 'enabled' : 'off'} ·
                payouts {Reflect.get(process.env, 'PAYOUT_ENABLED') === 'true' ? 'enabled' : 'off'}.
              </p>
              <p>
                Admin controls: launches {settings.launchPaused ? 'paused' : 'allowed'} · payouts{' '}
                {settings.payoutPaused ? 'paused' : 'allowed'}.
              </p>
              <p>
                Payout worker:{' '}
                {settings.payoutWorkerAt && Date.now() - +settings.payoutWorkerAt < 120000
                  ? 'ready'
                  : 'unavailable'}
              </p>
              <div className="form-actions">
                <AdminAction
                  action="finance"
                  id="global"
                  label={settings.launchPaused ? 'Resume launches' : 'Pause launches'}
                  values={{
                    launchPaused: !settings.launchPaused,
                    payoutPaused: settings.payoutPaused,
                  }}
                />
                <AdminAction
                  action="finance"
                  id="global"
                  label={settings.payoutPaused ? 'Resume payouts' : 'Pause payouts'}
                  values={{
                    launchPaused: settings.launchPaused,
                    payoutPaused: !settings.payoutPaused,
                  }}
                />
              </div>
              {pausedLaunches.map((launch) => (
                <div className="admin-row" key={launch.id}>
                  <strong>
                    {launch.name} · {launch.mint}
                  </strong>
                  <p>{launch.error}</p>
                  <AdminAction
                    action="launch-resume"
                    id={launch.id}
                    label="Resume after correction"
                    values={{}}
                  />
                </div>
              ))}
            </>
          )}
        </section>
        <section className="panel" id="creators">
          <h2>Creators</h2>
          {!users.length && <p>No creators match.</p>}
          {users.map((u) => (
            <div className="admin-row" key={u.id}>
              <strong>
                @{u.handle} · {u.suspended ? 'Suspended' : 'Active'}
              </strong>
              <AdminAction
                action="creator"
                id={u.id}
                label={u.suspended ? 'Restore access' : 'Suspend creator'}
                values={{ suspended: !u.suspended }}
              />
            </div>
          ))}
          <Pager
            param="creatorPage"
            page={creatorPage}
            hasNext={allUsers.length > ADMIN_PAGE}
            params={params}
            anchor="creators"
          />
        </section>
        <section className="panel" id="campaigns">
          <h2>Campaign moderation</h2>
          {!raids.length && <p>No campaigns match.</p>}
          {raids.map((r) => (
            <div className="admin-row" key={r.id}>
              <strong>{r.title}</strong>
              <p>
                @{r.creator.handle} · {r.status} · {r.coverage}
              </p>
              {r.collectionError && <p className="message error">{r.collectionError}</p>}
              <AdminAction
                action="raid"
                id={r.id}
                label={r.hidden ? 'Restore campaign' : 'Hide campaign'}
                values={{ hidden: !r.hidden }}
              />
              {r.fundingStatus === 'VERIFIED' &&
                !['ALLOCATED', 'HELD_RESOLVED'].includes(r.trackingPhase) &&
                (r.hidden || r.creator.suspended || r.trackingPhase === 'HELD') && (
                  <>
                    <p>
                      Releasing returns the whole reserved pool to the creator and forfeits
                      raiders&apos; accrued views on this Raid. To pay raiders instead, restore the
                      campaign or creator so settlement resumes.
                    </p>
                    <AdminAction
                      action="raid-release"
                      id={r.id}
                      label="Release reserved pool to creator"
                      values={{}}
                    />
                  </>
                )}
            </div>
          ))}
          <Pager
            param="campaignPage"
            page={campaignPage}
            hasNext={allRaids.length > ADMIN_PAGE}
            params={params}
            anchor="campaigns"
          />
        </section>
        <section className="panel" id="posts">
          <h2>Post moderation</h2>
          {!posts.length && <p>No posts match.</p>}
          {posts.map((p) => (
            <div className="admin-row" key={p.id}>
              <p>{p.text || 'Deleted / expired content'}</p>
              <p>X ID: {p.id}</p>
              <AdminAction
                action="post"
                id={p.id}
                label={p.hidden ? 'Restore post' : 'Hide post'}
                values={{ hidden: !p.hidden }}
              />
            </div>
          ))}
          <Pager
            param="postPage"
            page={postPage}
            hasNext={allPosts.length > ADMIN_PAGE}
            params={params}
            anchor="posts"
          />
        </section>
        <section className="panel" id="failures">
          <h2>Collection failures</h2>
          {!jobs.length && <p>No failed jobs.</p>}
          {jobs.map((j) => (
            <div className="admin-row" key={j.id}>
              <strong>
                {j.kind} ·{' '}
                {j.failedAt ? 'dead-lettered' : `attempt ${j.attempts}/${JOB_MAX_ATTEMPTS}`}
              </strong>
              <p>{j.error}</p>
              <AdminAction action="retry" id={j.id} label="Retry job" values={{}} />
            </div>
          ))}
        </section>
        <section className="panel" id="activity">
          <h2>Pilot activity this month</h2>
          <div className="admin-row">
            <p>Completed campaigns (all time): {completed}</p>
            <p>
              Creators with a second campaign (all time):{' '}
              {creatorCampaigns.filter((c) => c._count >= 2).length}
            </p>
            <p>Returning discovery visitors (seen on 2+ days): {visitors}</p>
          </div>
          {events.map((e) => (
            <div className="admin-row" key={e.type}>
              <strong>
                {e.type.replaceAll('_', ' ')}: {e._count}
              </strong>
            </div>
          ))}
          <h2 style={{ marginTop: 25 }}>Usage by campaign</h2>
          {campaignUsage.map((c) => (
            <div className="admin-row" key={c.raidId || 'identity'}>
              <p>
                {(c.raidId && usageTitles.get(c.raidId)) || c.raidId || 'Identity lookups'}: $
                {((c._sum.reservedCents || 0) / 100).toFixed(2)}
              </p>
            </div>
          ))}
          <h2 style={{ marginTop: 25 }}>Recent audit events</h2>
          {audit.map((a) => (
            <div className="admin-row" key={a.id}>
              <strong>
                {a.action} · {formatUtcDateTime(a.createdAt)}
              </strong>
              <p>{a.reason}</p>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
