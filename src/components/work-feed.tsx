import Link from 'next/link';
import { formatDisplayAmount } from '../contracts/assets';
import type { FeedCard, FeedPage, FeedQuery } from '../work-loop/feed-contracts';

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
      <h2>{item.title}</h2>
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
