import Link from 'next/link';
import { XDiagnostics } from '@/components/x-diagnostics';
import { currentUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { db } from '@/lib/db';
import { AdminAction, SettingsForm } from '@/components/admin';
export const dynamic = 'force-dynamic';
export default async function AdminPage() {
  const user = await currentUser();
  if (!user || user.role !== 'ADMIN')
    return (
      <div className="panel access-card">
        <h1>Operations</h1>
        <p>
          Administrator access is required to manage creators, moderate campaigns, and control
          collection.
        </p>
        {config.demo ? (
          <div className="notice info">Admin controls are disabled in the read-only preview.</div>
        ) : (
          <Link className="button" href="/api/auth/x">
            Sign in with X
          </Link>
        )}
      </div>
    );
  const now = new Date(),
    month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [settings, users, raids, posts, jobs, usage, events, audit] = await Promise.all([
    db.settings.upsert({ where: { id: 'global' }, create: {}, update: {} }),
    db.user.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    db.raid.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { creator: true } }),
    db.post.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
    db.job.findMany({
      where: { error: { not: null }, doneAt: null },
      orderBy: { runAt: 'desc' },
      take: 20,
    }),
    db.providerUsage.aggregate({
      where: { provider: 'x', at: { gte: month } },
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
    db.event.groupBy({
      by: ['visitor'],
      where: { type: 'discovery_view', visitor: { not: null }, at: { gte: month } },
      _count: true,
    }),
    db.providerUsage.groupBy({
      by: ['raidId'],
      where: { provider: 'x', at: { gte: month } },
      _sum: { reservedCents: true },
    }),
  ]);
  const pausedLaunches = await db.tokenLaunch.findMany({
    where: { status: 'PAUSED' },
    select: { id: true, mint: true, name: true, error: true },
    take: 20,
  });
  const spend = usage._sum.reservedCents || 0,
    ratio = spend / settings.monthlyBudgetCents;
  return (
    <>
      <div className="page-title">
        <h1>Operations</h1>
        <p>Keep the pilot useful, attributable, and within budget.</p>
      </div>
      <XDiagnostics userId={user.id} />
      {!config.liveApproved && (
        <div className="notice">
          Deployment feasibility gate is closed. Live X collection stays disabled regardless of the
          switch below.
        </div>
      )}
      {ratio >= 0.7 && (
        <div className="notice">
          {ratio >= 0.9 ? '90%' : '70%'} budget alert: conservative recorded usage has reached $
          {(spend / 100).toFixed(2)}.
        </div>
      )}
      <div className="metric-grid">
        <div>
          <span>Recorded X usage ceiling</span>
          <strong>${(spend / 100).toFixed(2)}</strong>
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
      <nav className="section-nav" aria-label="Operations sections">
        <a href="#limits">Operating limits</a>
        <a href="#finance">Launch & payouts</a>
        <a href="#creators">Creators</a>
        <a href="#campaigns">Campaigns</a>
        <a href="#posts">Posts</a>
        <a href="#failures">Failures</a>
        <a href="#activity">Activity & audit</a>
      </nav>
      <div className="admin-grid">
        <section className="panel" id="limits">
          <h2>Operating limits</h2>
          <SettingsForm settings={settings} />
        </section>
        <section className="panel" id="finance">
          <h2>Launch & payouts</h2>
          <p>
            Deployment switches: launches{' '}
            {Reflect.get(process.env, 'LAUNCH_ENABLED') === 'true' ? 'enabled' : 'off'} · payouts{' '}
            {Reflect.get(process.env, 'PAYOUT_ENABLED') === 'true' ? 'enabled' : 'off'}.
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
              values={{ launchPaused: !settings.launchPaused, payoutPaused: settings.payoutPaused }}
            />
            <AdminAction
              action="finance"
              id="global"
              label={settings.payoutPaused ? 'Resume payouts' : 'Pause payouts'}
              values={{ launchPaused: settings.launchPaused, payoutPaused: !settings.payoutPaused }}
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
        </section>
        <section className="panel" id="creators">
          <h2>Creator approvals</h2>
          {users
            .filter((u) => u.role !== 'ADMIN')
            .map((u) => (
              <div className="admin-row" key={u.id}>
                <strong>
                  @{u.handle} · {u.suspended ? 'Suspended' : u.approved ? 'Approved' : 'Pending'}
                </strong>
                <p>{u.affiliation || 'No affiliation submitted.'}</p>
                <AdminAction
                  action="creator"
                  id={u.id}
                  label={u.approved ? 'Revoke approval' : 'Approve creator'}
                  values={{ approved: !u.approved, suspended: u.suspended }}
                />
                <AdminAction
                  action="creator"
                  id={u.id}
                  label={u.suspended ? 'Restore access' : 'Suspend creator'}
                  values={{ approved: u.approved, suspended: !u.suspended }}
                />
              </div>
            ))}
        </section>
        <section className="panel" id="campaigns">
          <h2>Campaign moderation</h2>
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
            </div>
          ))}
        </section>
        <section className="panel" id="posts">
          <h2>Post moderation</h2>
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
        </section>
        <section className="panel" id="failures">
          <h2>Collection failures</h2>
          {!jobs.length && <p>No failed jobs.</p>}
          {jobs.map((j) => (
            <div className="admin-row" key={j.id}>
              <strong>
                {j.kind} · attempt {j.attempts}/8
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
            <p>Returning discovery visitors: {visitors.filter((v) => v._count >= 2).length}</p>
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
                {raids.find((r) => r.id === c.raidId)?.title || c.raidId || 'Identity lookups'}: $
                {((c._sum.reservedCents || 0) / 100).toFixed(2)}
              </p>
            </div>
          ))}
          <h2 style={{ marginTop: 25 }}>Recent audit events</h2>
          {audit.map((a) => (
            <div className="admin-row" key={a.id}>
              <strong>
                {a.action} · {new Date(a.createdAt).toLocaleString('en', { timeZone: 'UTC' })} UTC
              </strong>
              <p>{a.reason}</p>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
