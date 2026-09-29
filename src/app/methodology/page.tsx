import Link from 'next/link';
export default function Methodology() {
  return (
    <article className="prose">
      <h1>Attention, with the context.</h1>
      <p>
        useRAID measures public participation in specific Solana community campaigns. It does not
        measure all conversation about a token, assess project quality, or predict future prices.
      </p>
      <h2>What counts as a raid post?</h2>
      <p>
        A post must mention the official useRAID account, include exactly one registered raid
        hashtag, and be published within the campaign window. Original posts, replies, and quote
        posts qualify. Repost wrappers do not count as additional posts, but their counts contribute
        to observed interactions.
      </p>
      <h2>The numbers you see</h2>
      <ul>
        <li>
          Raiders are distinct X authors of qualifying posts. They are not unique viewers or people
          who liked a post.
        </li>
        <li>
          Interactions are observed likes, replies, reposts, and quotes. These counts can overlap
          between people and can decrease.
        </li>
        <li>
          Token totals deduplicate posts and participating authors across that token’s campaigns.
        </li>
      </ul>
      <h2>Attention score v1</h2>
      <div className="formula">
        Post points = 1 + log₂(1 + interactions)
        <br />
        Author points = top 3 posts, capped at 20 points
        <br />
        Raid score = sum of author points × 100
      </div>
      <p style={{ marginTop: 18 }}>
        Only posts created in the trailing hour contribute. Normalized duplicate text contributes
        once, using the earliest eligible post. Normalization removes mentions, raid tags, URLs,
        punctuation, and repeated whitespace. Moderated and deleted posts are excluded.
      </p>
      <p>
        This is an experimental measure with limited resistance to manipulation. We do not claim to
        verify that every account represents a unique human or that engagement is organic.
      </p>
      <h2>pump.fun launch rewards</h2>
      <p>
        New tokens launched through useRAID are ordinary SOL-paired pump.fun tokens. Creator fees
        arrive at a unique fee wallet managed by useRAID. A launching wallet starts a 24-hour raid;
        token owners can start later raids after the current one ends.
      </p>
      <p>
        To earn, a participant verifies an X account and Solana wallet, joins that token’s rewards,
        and posts after joining. Each completed hour uses the same duplicate filter, top-three-post
        rule, and 20-point author cap shown above. We wait until X search covers the full hour.
        After recorded network costs, 90% of claimed fees are allocated by score and 10% goes to
        useRAID. Balances under 0.001 SOL carry forward. Missing collection delays payout.
      </p>
      <h2>Discovery and momentum</h2>
      <p>
        Trending orders active campaigns by score. Rising requires at least five participating
        authors, a complete comparison baseline, and a positive score increase over one hour.
        Momentum compares the current score with one hour earlier. Missing or zero baselines display
        “Building baseline.”
      </p>
      <h2>Freshness and coverage</h2>
      <p>
        Collection targets five-minute intervals. Pages refresh cached results every 30 seconds.
        Rate limits, budgets, provider errors, and incomplete search results can delay collection.
        Stale and partial measurements are labeled. A missing measurement is not proof that no
        activity occurred.
      </p>
      <h2>Markets and project approval</h2>
      <p>
        Market data comes from DEX Screener’s most liquid eligible Solana pair. Market cap and fully
        diluted valuation (FDV) are distinct. Creator approval grants pilot access; it is not an
        endorsement. Trading opens Jupiter using the exact token mint.
      </p>
      <h2>Preview data</h2>
      <p>
        When the product preview banner is visible, all campaigns and figures are illustrative.
        Token names demonstrate the interface and do not imply affiliation. Posting, trading, and
        admin mutations are disabled.
      </p>
      <Link href="/">Return to discovery</Link>
    </article>
  );
}
