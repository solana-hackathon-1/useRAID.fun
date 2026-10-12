import Link from 'next/link';
export default function Methodology() {
  return (
    <article className="prose">
      <h1>How it works</h1>
      <p>
        useRAID lets a project fund Raids and pay people in USDC for public X posts about it. This
        page covers what the app does and where its limits are.
      </p>
      <h2>The flow</h2>
      <ol>
        <li>Connect X. Your X account is how you sign in and how posts are attributed to you.</li>
        <li>
          Verify a Solana wallet by signing a message. This is not a transaction and moves no funds.
        </li>
        <li>
          Creators fund a Raid from a USDC balance, pick the target X posts, an impression target
          and a duration, and see a quote before launching.
        </li>
        <li>
          Raiders join a Raid and post originals or quotes that link a target post and mention the
          official account.
        </li>
        <li>
          Results are reviewed and open to disputes for two hours. Payouts are manually signed
          transfers.
        </li>
      </ol>
      <h2>How rewards work</h2>
      <p>
        Verified views earn a proportional share up to the Raid&apos;s target, and no one raider
        earns more than 25% of the pool. A creator cannot join or be paid from their own Raid.
        Unused funds return to the creator, and amounts below the minimum payout stay on the
        raider&apos;s balance. Missing X view counts delay allocation.
      </p>
      <div className="formula">
        Post points = 100 × (1 + log₂(1 + likes + replies + reposts + quotes))
        <br />
        Participant score = sum of best 10 posts, rounded once
      </div>
      <h2>What useRAID does not do</h2>
      <ul>
        <li>It does not measure all conversation, judge project quality or predict prices.</li>
        <li>This is not investment advice. Token trading and launches are coming soon.</li>
        <li>
          Impressions are not unique people, delivery is not guaranteed, and accounts are not
          verified as unique humans.
        </li>
        <li>CPA here is paid USDC per qualifying post, not customers or sales.</li>
        <li>
          Data refreshes about every five minutes and can lag. Stale or partial figures are labeled,
          and a missing figure does not prove no activity.
        </li>
        <li>
          When the preview banner shows, every campaign and figure is illustrative and posting,
          trading and admin actions are disabled.
        </li>
      </ul>
      <Link href="/">Return to discovery</Link>
    </article>
  );
}
