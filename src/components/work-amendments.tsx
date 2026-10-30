'use client';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  createAmendmentClient,
  describeAmendmentFailure,
  type AmendmentClient,
  type AmendmentDeskView,
  type AmendmentView,
} from '../work-http/amendment-client';
import {
  amountText,
  assetLabel,
  buildProposal,
  canAnswer,
  describeChanges,
  formFrom,
  isLapsed,
  termsKey,
  type ProposalForm,
} from '../work-http/amendment-form';
import { newRequestKey, type FailureKind } from '../work-http/workspace-client';

const defaultClient = createAmendmentClient();
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
/** Wall clock in coarse steps so a proposal lapses on screen without a reload; unknown on the server. */
const CLOCK_STEP = 15_000;
const subscribeClock = (notify: () => void) => {
  const timer = setInterval(notify, CLOCK_STEP);
  return () => clearInterval(timer);
};
const clockNow = () => Math.floor(Date.now() / CLOCK_STEP) * CLOCK_STEP;
const serverClock = () => null;
const wrap = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
type Engagement = AmendmentDeskView['engagements'][number];

function when(value: string) {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value)) + ' UTC'
  );
}
const STATE_TEXT: Record<AmendmentView['state'], string> = {
  PROPOSED: 'Waiting for the member',
  ACCEPTED: 'Agreed',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn by the Founder',
};
interface Notice {
  intent: string;
  kind: FailureKind;
  text: string;
}
/** One idempotency key per unchanged intent, kept across unconfirmed failures so a retry cannot duplicate. */
function useRunner(reload: () => Promise<void>, seed: Notice | null = null) {
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(seed);
  const [done, setDone] = useState<string | null>(null);
  async function run(
    intent: string,
    fingerprint: unknown,
    exec: (key: string) => Promise<unknown>,
    success: string,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = intent + ':' + JSON.stringify(fingerprint);
    let key = keys.current.get(id);
    if (!key) keys.current.set(id, (key = newRequestKey()));
    setBusy(intent);
    setNotice(null);
    setDone(null);
    try {
      await exec(key);
      keys.current.delete(id);
      setDone(success);
      try {
        await reload();
      } catch {
        setNotice({
          intent,
          kind: 'REFRESH',
          text: 'Saved, but the latest view could not be loaded. Refresh to see it.',
        });
      }
    } catch (error) {
      const described = describeAmendmentFailure(error);
      if (described.kind !== 'RETRY_SAME_REQUEST') keys.current.delete(id);
      setNotice({ intent, kind: described.kind, text: described.message });
      // A stale or already-answered proposal is fixed by showing the current one.
      if (described.kind === 'REFRESH') void reload().catch(() => {});
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  return { run, busy, notice, done, dismiss: () => setNotice(null) };
}
type Runner = ReturnType<typeof useRunner>;
function NoticeText({ n, refresh }: { n: Notice; refresh?: () => void }) {
  return (
    <p role="alert">
      {n.text}{' '}
      {n.kind === 'REFRESH' && refresh && (
        <button type="button" className="button secondary" onClick={refresh}>
          Refresh
        </button>
      )}
      {n.kind === 'SIGN_IN' && <a href="/creator/account">Sign in</a>}
      {n.kind === 'RETRY_SAME_REQUEST' && ' Press the same button again to retry.'}
    </p>
  );
}
/**
 * A card-local notice for its own action. "Refresh" notices are shown once at the top of the panel instead, because
 * the reload they trigger can remove the card that raised them.
 */
function Feedback({ runner, intent }: { runner: Runner; intent: string }) {
  const n = runner.notice && runner.notice.intent === intent ? runner.notice : null;
  return n && n.kind !== 'REFRESH' ? <NoticeText n={n} /> : null;
}
function Changes({
  current,
  proposed,
}: {
  current: Engagement['effectiveTerms'];
  proposed: AmendmentView;
}) {
  const changes = describeChanges(current, proposed.terms);
  const raised = changes.some((c) => c.kind === 'reward' && c.direction === 'UP');
  return (
    <>
      <ul>
        {changes.map((c) => (
          <li key={c.label} style={wrap}>
            <strong>{c.label}</strong>:{' '}
            {c.kind === 'deadline' ? (
              <>
                <time dateTime={c.before}>{when(c.before)}</time> →{' '}
                <time dateTime={c.after}>{when(c.after)}</time>
              </>
            ) : (
              <>
                {c.before} → {c.after}
                {c.direction === 'UP' ? ' (more)' : c.direction === 'DOWN' ? ' (less)' : ''}
              </>
            )}
          </li>
        ))}
      </ul>
      {raised && (
        <p className="orientation-hint">
          The added reward is covered by simulated funding only; no money has moved.
        </p>
      )}
    </>
  );
}
function MemberCard({
  engagement,
  open,
  available,
  ready,
  runner,
  api,
  now,
}: {
  engagement: Engagement;
  open: AmendmentView;
  available: boolean;
  ready: boolean;
  runner: Runner;
  api: AmendmentClient;
  now: number | null;
}) {
  const acceptIntent = 'agree:' + open.id;
  const declineIntent = 'decline:' + open.id;
  const lapsed = isLapsed(open.expiresAt, now);
  const disabled = !canAnswer({ ready, available, busy: runner.busy !== null, lapsed });
  return (
    <section className="orientation-card" aria-label={'Proposed change: ' + engagement.title}>
      <h3>{'Proposed change: ' + engagement.title}</h3>
      <p>
        <strong>Your current terms stay in force until you agree.</strong> The Founder cannot change
        them alone.{' '}
        {lapsed ? (
          <>
            This proposal has lapsed (it expired{' '}
            <time dateTime={open.expiresAt}>{when(open.expiresAt)}</time>
            ). Nothing changed and it can no longer be agreed.
          </>
        ) : (
          <>
            Answer by <time dateTime={open.expiresAt}>{when(open.expiresAt)}</time>; after that this
            proposal lapses and nothing changes.
          </>
        )}
      </p>
      <Changes current={engagement.effectiveTerms} proposed={open} />
      <p className="orientation-hint">
        Agreeing records your consent to exactly this version (reference {open.digest.slice(0, 12)}…
        ).
      </p>
      {!available && <p role="status">Responding to a proposed change is currently unavailable.</p>}
      <fieldset className="orientation-fields" disabled={disabled}>
        <legend className="visually-hidden">Answer the proposed change</legend>
        <div className="orientation-actions">
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() =>
              void runner.run(
                acceptIntent,
                open.digest,
                (key) => api.accept(open.id, open.digest, key),
                'You agreed to the change. It is now part of your terms.',
              )
            }
          >
            {runner.busy === acceptIntent ? 'Saving…' : 'Agree to this change'}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() =>
              void runner.run(
                declineIntent,
                open.id,
                (key) => api.decline(open.id, key),
                'You declined the change. Your terms are unchanged.',
              )
            }
          >
            {runner.busy === declineIntent ? 'Saving…' : 'Decline'}
          </button>
        </div>
      </fieldset>
      <Feedback runner={runner} intent={acceptIntent} />
      <Feedback runner={runner} intent={declineIntent} />
    </section>
  );
}
function History({ amendments }: { amendments: AmendmentView[] }) {
  const decided = amendments.filter((a) => a.state !== 'PROPOSED');
  if (!decided.length) return null;
  return (
    <ul>
      {decided.map((a) => (
        <li key={a.id}>
          Proposal {a.sequence}: {STATE_TEXT[a.state]}
        </li>
      ))}
    </ul>
  );
}
function FounderCard({
  engagement,
  open,
  available,
  ready,
  runner,
  api,
  now,
}: {
  engagement: Engagement;
  open: AmendmentView | undefined;
  available: boolean;
  ready: boolean;
  runner: Runner;
  api: AmendmentClient;
  now: number | null;
}) {
  const current = engagement.effectiveTerms;
  const intent = 'propose:' + engagement.engagementId;
  const withdrawIntent = 'withdraw:' + (open?.id ?? engagement.engagementId);
  const [form, setForm] = useState<ProposalForm>(() => formFrom(current));
  const [problem, setProblem] = useState('');
  const lapsed = open ? isLapsed(open.expiresAt, now) : false;
  const disabled = !ready || !available || runner.busy !== null;
  function submit(event: FormEvent) {
    event.preventDefault();
    const built = buildProposal(engagement.engagementId, current, form, Date.now());
    if (!built.ok) {
      setProblem(built.problem);
      return;
    }
    setProblem('');
    void runner.run(
      intent,
      built.input,
      (key) => api.propose(built.input, key),
      'Proposal sent. Nothing changes unless the member agrees to exactly this version.',
    );
  }
  const set = (patch: Partial<ProposalForm>) => setForm({ ...form, ...patch });
  return (
    <section className="orientation-card" aria-label={'Propose change: ' + engagement.title}>
      <h3>{'Propose change: ' + engagement.title}</h3>
      <p style={wrap}>Current scope: {current.scope}</p>
      <p>
        Current reward: {current.rewards.map(amountText).join(', ')}. Submission due{' '}
        <time dateTime={current.deadlines.submission}>{when(current.deadlines.submission)}</time>.
      </p>
      {open ? (
        <>
          {lapsed ? (
            <p role="status">
              Your proposal has lapsed (it expired{' '}
              <time dateTime={open.expiresAt}>{when(open.expiresAt)}</time>) and the member can no
              longer agree to it. Withdraw it to propose a new change.
            </p>
          ) : (
            <p role="status">
              Your proposal is waiting for the member to agree. It takes effect only if they agree
              to exactly this version; it lapses on{' '}
              <time dateTime={open.expiresAt}>{when(open.expiresAt)}</time>.
            </p>
          )}
          <Changes current={current} proposed={open} />
          <button
            type="button"
            className="button secondary"
            disabled={disabled}
            onClick={() =>
              void runner.run(
                withdrawIntent,
                open.id,
                (key) => api.withdraw(open.id, key),
                'Proposal withdrawn. The member’s terms are unchanged.',
              )
            }
          >
            Withdraw proposal
          </button>
          {!available && <p role="status">Withdrawing is currently unavailable.</p>}
          <Feedback runner={runner} intent={withdrawIntent} />
        </>
      ) : (
        <form onSubmit={submit} noValidate aria-label={'Propose a change: ' + engagement.title}>
          {!available && <p role="status">Proposing a change is currently unavailable.</p>}
          <p className="orientation-hint">
            A change takes effect only if the member agrees to exactly this version. An increase in
            reward needs funding coverage first; coverage here is simulated and no money moves.
          </p>
          <fieldset className="orientation-fields" disabled={disabled}>
            <legend className="visually-hidden">Proposed terms</legend>
            <label>
              New scope
              <textarea
                rows={3}
                maxLength={8000}
                value={form.scope}
                onChange={(e) => set({ scope: e.target.value })}
              />
            </label>
            <label>
              Acceptance criteria (one per line)
              <textarea
                rows={4}
                value={form.criteria}
                onChange={(e) => set({ criteria: e.target.value })}
              />
            </label>
            {current.rewards.map((leg, i) => (
              <label key={i}>
                {`Reward ${i + 1} (${assetLabel(leg.policy)})`}
                <input
                  inputMode="decimal"
                  value={form.rewards[i] ?? ''}
                  onChange={(e) =>
                    set({ rewards: form.rewards.map((r, j) => (j === i ? e.target.value : r)) })
                  }
                />
              </label>
            ))}
            {(
              [
                ['preparation', 'Preparation due (UTC)'],
                ['submission', 'Submission due (UTC)'],
                ['review', 'Review due (UTC)'],
                ['operationalClosure', 'Closes by (UTC)'],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="datetime-local"
                  value={form.deadlines[key]}
                  onChange={(e) => set({ deadlines: { ...form.deadlines, [key]: e.target.value } })}
                />
              </label>
            ))}
            <label>
              Proposal valid until (UTC)
              <input
                type="datetime-local"
                value={form.expiresAt}
                onChange={(e) => set({ expiresAt: e.target.value })}
              />
              <span className="orientation-hint">
                Must be in the future and before the current submission deadline.
              </span>
            </label>
          </fieldset>
          {problem && <p role="alert">{problem}</p>}
          <Feedback runner={runner} intent={intent} />
          <div className="orientation-actions">
            <button className="button" type="submit" disabled={disabled}>
              {runner.busy === intent ? 'Sending…' : 'Propose change'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * Own amendment area. `MEMBER` shows the consent card for a waiting proposal; `FOUNDER` shows the propose form. The
 * server decides every outcome; this only presents the current record and sends the person's explicit answer.
 */
export function AmendmentPanel({
  role,
  initial,
  api = defaultClient,
  now: fixedNow,
  initialNotice,
}: {
  role: 'MEMBER' | 'FOUNDER';
  initial?: AmendmentDeskView;
  api?: AmendmentClient;
  /** A fixed clock (epoch ms) for a deterministic render; omitted, the browser clock is used. */
  now?: number;
  /** A notice already showing, used to render a known state without an action. */
  initialNotice?: Notice;
}) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const clock = useSyncExternalStore(subscribeClock, clockNow, serverClock);
  const now = fixedNow ?? clock;
  const [desk, setDesk] = useState<AmendmentDeskView | null>(initial ?? null);
  const [failure, setFailure] = useState('');
  async function reload() {
    setDesk(await api.desk());
    setFailure('');
  }
  const refresh = () => {
    reload().catch(() => setFailure('The latest view could not be loaded. Try again.'));
  };
  useEffect(() => {
    if (initial) return;
    // The first load runs once; later loads are explicit refreshes after an action.
    let live = true;
    api
      .desk()
      .then((next) => live && setDesk(next))
      .catch(() => live && setFailure('The latest view could not be loaded. Try again.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const runner = useRunner(reload, initialNotice ?? null);
  const refreshNotice = () => {
    runner.dismiss();
    refresh();
  };
  const mine = (desk?.engagements ?? []).filter((e) => e.role === role);
  const available = desk?.proposalsAvailable ?? false;
  const heading =
    role === 'MEMBER' ? 'Changes to your accepted terms' : 'Propose a change to accepted terms';
  return (
    <section aria-labelledby={'amendments-' + role}>
      <h2 id={'amendments-' + role}>{heading}</h2>
      {runner.done && <p role="status">{runner.done}</p>}
      {runner.notice?.kind === 'REFRESH' && (
        <NoticeText n={runner.notice} refresh={refreshNotice} />
      )}
      {!desk && !failure && <p role="status">Loading changes to accepted terms…</p>}
      {failure && <p role="alert">{failure}</p>}
      {desk && role === 'MEMBER' && (
        <>
          {mine.length === 0 && (
            <p>No change has been proposed. Your accepted terms stay in force.</p>
          )}
          {mine.map((e) => {
            const open = e.amendments.find((a) => a.state === 'PROPOSED');
            return (
              <div key={e.engagementId}>
                {open ? (
                  <MemberCard
                    engagement={e}
                    open={open}
                    available={available}
                    ready={ready}
                    runner={runner}
                    api={api}
                    now={now}
                  />
                ) : (
                  <p>
                    {e.amendments.length === 0
                      ? `No change has been proposed to “${e.title}”.`
                      : `No change is waiting for your answer on “${e.title}”.`}{' '}
                    Your accepted terms stay in force.
                  </p>
                )}
                <History amendments={e.amendments} />
              </div>
            );
          })}
        </>
      )}
      {desk && role === 'FOUNDER' && (
        <>
          {mine.length === 0 && <p>You have no accepted work that can be changed.</p>}
          {mine.map((e) => (
            <div key={e.engagementId}>
              <FounderCard
                key={termsKey(e.effectiveTerms)}
                engagement={e}
                open={e.amendments.find((a) => a.state === 'PROPOSED')}
                available={available}
                ready={ready}
                runner={runner}
                api={api}
                now={now}
              />
              <History amendments={e.amendments} />
            </div>
          ))}
        </>
      )}
    </section>
  );
}
