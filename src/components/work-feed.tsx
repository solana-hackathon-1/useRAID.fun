import Link from 'next/link';
import { formatDisplayAmount } from '../contracts/assets';
import { AcceptRaid } from './work-accept';
import { ApplyToRaid } from './work-apply';
import type { ApplyMode } from '../lib/work-apply-mode';
import type { Detail, FeedCard, FeedPage, FeedQuery } from '../work-loop/feed-contracts';

const FEED_PATH = '/raids';
const RANKS = ['E', 'D', 'C', 'B', 'A', 'S'] as const;
const KINDS: Readonly<Record<string, string>> = {
  HUMAN: 'People',
  AI_AGENT: 'AI agents',
  AI_INFLUENCER: 'AI influencers',
};
type Filters = Partial<Omit<FeedQuery, 'cursor'>> & { cursor?: string | null };
const ORDER = [
  'category',
  'skillId',
  'difficulty',
  'participantKind',
  'execution',
  'admission',
  'assetKey',
  'closesBefore',
  'sort',
  'limit',
  'cursor',
] as const;
/** The feed URL for a set of filters. Defaults are omitted so a cleared feed is just the path. */
export function feedHref(query: Filters) {
  const params = new URLSearchParams();
  for (const name of ORDER) {
    const value = query[name];
    if (value === undefined || value === null || value === '') continue;
    if ((name === 'sort' && value === 'newest') || (name === 'limit' && value === 20)) continue;
    params.set(name, String(value));
  }
  const text = params.toString();
  return text ? `${FEED_PATH}?${text}` : FEED_PATH;
}
function assetLabel(asset: FeedCard['rewards'][number]['assetId']) {
  return asset.kind === 'NATIVE_SOL' ? 'SOL' : `${asset.mint.slice(0, 4)}…${asset.mint.slice(-4)}`;
}
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium' });
const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const when = (iso: string) => `${day.format(new Date(iso))}, ${clock.format(new Date(iso))} UTC`;
function Option({ value, label }: { value: string; label: string }) {
  return <option value={value}>{label}</option>;
}
function Filter({ query, assets }: { query: Filters; assets: Map<string, string> }) {
  return (
    <form className="raid-feed-filters" method="get" action={FEED_PATH}>
      <label>
        Category
        <input name="category" defaultValue={query.category ?? ''} maxLength={64} />
      </label>
      <label>
        Skill
        <input name="skillId" defaultValue={query.skillId ?? ''} maxLength={64} />
      </label>
      <label>
        Difficulty
        <select name="difficulty" defaultValue={query.difficulty ?? ''}>
          <Option value="" label="Any" />
          {RANKS.map((rank) => (
            <Option key={rank} value={rank} label={`Rank ${rank}`} />
          ))}
        </select>
      </label>
      <label>
        Who can take it
        <select name="participantKind" defaultValue={query.participantKind ?? ''}>
          <Option value="" label="Anyone" />
          {Object.entries(KINDS).map(([value, label]) => (
            <Option key={value} value={value} label={label} />
          ))}
        </select>
      </label>
      <label>
        Format
        <select name="execution" defaultValue={query.execution ?? ''}>
          <Option value="" label="Any" />
          <Option value="SOLO" label="Solo" />
          <Option value="PARTY" label="Party" />
        </select>
      </label>
      <label>
        Admission
        <select name="admission" defaultValue={query.admission ?? ''}>
          <Option value="" label="Any" />
          <Option value="INSTANT" label="Instant" />
          <Option value="APPLICATION" label="Application" />
        </select>
      </label>
      <label>
        Reward asset
        <select name="assetKey" defaultValue={query.assetKey ?? ''}>
          <Option value="" label="Any asset" />
          {[...assets].map(([value, label]) => (
            <Option key={value} value={value} label={label} />
          ))}
        </select>
      </label>
      <label>
        Apply before
        <input
          name="closesBefore"
          type="date"
          defaultValue={query.closesBefore?.slice(0, 10) ?? ''}
        />
      </label>
      <label>
        Order
        <select name="sort" defaultValue={query.sort ?? 'newest'}>
          <Option value="newest" label="Newest" />
          <Option value="deadline" label="Soonest deadline" />
          <Option value="reward" label="Largest reward (one asset)" />
        </select>
      </label>
      <div className="raid-feed-actions">
        <button className="button" type="submit">
          Apply filters
        </button>
        <Link className="inline-link" href={FEED_PATH}>
          Clear
        </Link>
      </div>
    </form>
  );
}
function Card({ item }: { item: FeedCard }) {
  return (
    <li className="raid-feed-card">
      <h2>
        <Link href={`/raids/work/${item.listingId}`}>{item.title}</Link>
      </h2>
      <p className="raid-feed-guild">Guild {item.guildId}</p>
      <p>{item.publicSummary}</p>
      <ul className="raid-feed-tags" aria-label="Details">
        <li>{item.category}</li>
        <li>Rank {item.difficulty}</li>
        <li>{item.execution === 'SOLO' ? 'Solo' : 'Party'}</li>
        <li>{item.admission === 'APPLICATION' ? 'Application required' : 'Instant start'}</li>
        <li>{item.participantKinds.map((kind) => KINDS[kind] ?? kind).join(', ')}</li>
      </ul>
      <p className="raid-feed-skills">
        Skills: {item.requiredSkills.map((s) => `${s.skillId} (${s.minimumRank}+)`).join(', ')}
      </p>
      <ul className="raid-feed-rewards" aria-label="Rewards">
        {item.rewards.map((reward) => (
          <li key={reward.assetKey}>
            {formatDisplayAmount(reward.amount, reward.decimals)} {assetLabel(reward.assetId)}
          </li>
        ))}
      </ul>
      <p>
        Apply by {when(item.commitmentDeadline)} · {item.availableSlots} open{' '}
        {item.availableSlots === 1 ? 'slot' : 'slots'}
      </p>
      <p className="raid-feed-funding">
        Simulated funding: a reservation is recorded for this Raid, but no real funds are held.
      </p>
    </li>
  );
}
/** Server-rendered public Raid feed. Filters are a plain GET form, so it works without JavaScript. */
export function WorkFeed({ page, query }: { page: FeedPage; query: Filters }) {
  const assets = new Map<string, string>();
  for (const item of page.items)
    for (const reward of item.rewards) assets.set(reward.assetKey, assetLabel(reward.assetId));
  if (query.assetKey && !assets.has(query.assetKey)) assets.set(query.assetKey, 'Selected asset');
  return (
    <section className="raid-feed" aria-labelledby="raid-feed-title">
      <h1 id="raid-feed-title">Live Raids</h1>
      <p className="raid-feed-intro">
        Funded, open work from Guilds. Eligibility is checked when you apply; nothing here grants
        access. Reward order needs one asset: amounts in different assets are not comparable.
      </p>
      <Filter query={query} assets={assets} />
      {page.items.length ? (
        <ul className="raid-feed-grid">
          {page.items.map((item) => (
            <Card key={item.listingId} item={item} />
          ))}
        </ul>
      ) : (
        <div className="raid-feed-empty" role="status">
          <p>No live Raids match these filters.</p>
          <Link className="button secondary" href={FEED_PATH}>
            Show all live Raids
          </Link>
        </div>
      )}
      {page.nextCursor ? (
        <p>
          <Link className="button secondary" href={feedHref({ ...query, cursor: page.nextCursor })}>
            Next Raids
          </Link>
        </p>
      ) : null}
    </section>
  );
}
function List({ title, items }: { title: string; items: readonly string[] }) {
  return items.length ? (
    <section>
      <h2>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  ) : null;
}
function Policy({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <dt>{title}</dt>
      <dd>{text}</dd>
    </div>
  );
}
/** The full public brief of one live Raid: what a person commits to, in the accepted-terms order. */
export type { ApplyMode };
export function WorkDetail({
  detail,
  apply = 'NOT_APPLICABLE',
  offer,
  applied = false,
  applySlotId,
}: {
  detail: Detail;
  apply?: ApplyMode;
  /** The viewer already has a submitted application for these terms. */
  applied?: boolean;
  /** The open slot this viewer applies to; defaults to the first. */
  applySlotId?: string;
  /** The viewer's own usable offer for these terms: accepting through it replaces applying. */
  offer?: { offerId: string; slotId: string } | null;
}) {
  const rounds = detail.review.maxRevisionRounds;
  return (
    <article className="raid-feed raid-detail" aria-labelledby="raid-detail-title">
      <p>
        <Link className="inline-link" href={FEED_PATH}>
          ← All live Raids
        </Link>
      </p>
      <h1 id="raid-detail-title">{detail.title}</h1>
      <p className="raid-feed-guild">Guild {detail.guildId}</p>
      <p>{detail.publicSummary}</p>
      <ul className="raid-feed-tags" aria-label="Details">
        <li>{detail.category}</li>
        <li>Rank {detail.difficulty}</li>
        <li>{detail.execution === 'SOLO' ? 'Solo' : 'Party'}</li>
        <li>{detail.admission === 'APPLICATION' ? 'Application required' : 'Instant start'}</li>
        <li>{detail.participantKinds.map((kind) => KINDS[kind] ?? kind).join(', ')}</li>
      </ul>
      <ul className="raid-feed-rewards" aria-label="Rewards">
        {detail.rewards.map((reward) => (
          <li key={reward.assetKey}>
            {formatDisplayAmount(reward.amount, reward.decimals)} {assetLabel(reward.assetId)}
          </li>
        ))}
      </ul>
      <p className="raid-feed-funding">
        Simulated funding: a reservation is recorded for this Raid, but no real funds are held.
      </p>
      <section>
        <h2>Outcome</h2>
        <p>{detail.outcome}</p>
      </section>
      <List title="Deliverables" items={detail.deliverables} />
      <List title="Acceptance criteria" items={detail.acceptanceCriteria} />
      <List title="Not included" items={detail.exclusions} />
      <List title="Depends on" items={detail.dependencies} />
      <section>
        <h2>Skills</h2>
        <ul>
          {detail.requiredSkills.map((s) => (
            <li key={s.skillId}>
              {s.skillId}, rank {s.minimumRank} or higher
            </li>
          ))}
        </ul>
        <p>{detail.allowedToolsPolicy}</p>
      </section>
      <section>
        <h2>Deadlines</h2>
        <dl className="raid-detail-terms">
          <Policy title="Apply by" text={when(detail.deadlines.commitment)} />
          <Policy title="Preparation" text={when(detail.deadlines.preparation)} />
          <Policy title="Submit by" text={when(detail.deadlines.submission)} />
          <Policy title="Review by" text={when(detail.deadlines.review)} />
          <Policy title="Operational closure" text={when(detail.deadlines.operationalClosure)} />
        </dl>
        <p>Start condition: {detail.startCondition}</p>
      </section>
      <section>
        <h2>How it is reviewed</h2>
        <p>{detail.review.evidence}</p>
        <p>
          Up to {rounds} revision {rounds === 1 ? 'round' : 'rounds'}.
        </p>
      </section>
      <section>
        <h2>Terms</h2>
        <dl className="raid-detail-terms">
          <Policy title="Rights" text={detail.rightsPolicy} />
          <Policy title="Portfolio" text={detail.portfolioPolicy} />
          <Policy title="Withdrawal" text={detail.withdrawalPolicy} />
          <Policy title="Termination" text={detail.terminationPolicy} />
          <Policy title="Disputes" text={detail.disputePolicy} />
          <Policy title="Finality" text={detail.finalityPolicy} />
        </dl>
      </section>
      <section className="raid-feed-empty" aria-label="Taking this Raid">
        <h2>Taking this Raid</h2>
        {offer ? (
          <AcceptRaid
            slotId={offer.slotId}
            termsVersionId={detail.termsVersionId}
            termsDigest={detail.termsDigest}
            offerId={offer.offerId}
          />
        ) : apply === 'ACCEPT' ? (
          <AcceptRaid
            slotId={detail.openSlotIds[0]}
            termsVersionId={detail.termsVersionId}
            termsDigest={detail.termsDigest}
          />
        ) : apply === 'FORM' ? (
          <ApplyToRaid
            slotId={applySlotId ?? detail.openSlotIds[0]}
            termsVersionId={detail.termsVersionId}
            applied={applied}
          />
        ) : apply === 'SIGN_IN' ? (
          <>
            <p>
              Sign in to {detail.admission === 'APPLICATION' ? 'apply' : 'take this Raid'}.
              Eligibility is checked by the server when you act.
            </p>
            <Link className="button" href="/creator/account">
              {detail.admission === 'APPLICATION'
                ? 'Sign in to apply'
                : 'Sign in to take this Raid'}
            </Link>
          </>
        ) : apply === 'CLOSED' ? (
          <p>
            {detail.admission === 'APPLICATION'
              ? 'Applications are not open yet.'
              : 'Accepting is not open yet.'}{' '}
            Eligibility is checked by the server when you act.
          </p>
        ) : (
          <p>
            Applying and accepting are not available in the browser for this Raid. Eligibility is
            checked by the server when you act, never from this page.
          </p>
        )}
        <Link className="button secondary" href={FEED_PATH}>
          Back to live Raids
        </Link>
      </section>
    </article>
  );
}
