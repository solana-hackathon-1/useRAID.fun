export default function Privacy() {
  return (
    <article className="prose">
      <h1>Data and privacy</h1>
      <p>
        useRAID stores the X user ID and handle of signed-in creators, any previously submitted
        project affiliation, campaign information, and a server-side login session. Sign-in requests
        read access only. Access tokens are used for identity lookup and are not retained.
      </p>
      <p>
        Wallet sign-in stores a verified Solana address and a short-lived, single-use signing
        challenge. Creator Studio stores an append-only USDC balance ledger, deposit/withdrawal
        intents, target post previews, and reviewed allocations. Funded Raids store payment
        signatures, funding amount, verified recipient and refund wallets, result allocations, and
        payout receipts. On-chain transfers and addresses are public. Token launch and creator-fee
        flows are coming soon.
      </p>
      <h2>Public campaign data</h2>
      <p>
        We collect attributed public X posts, author IDs, timestamps, public engagement counts, and
        views when X provides them. Collection checks posts for explicit unavailable responses.
        Review snapshots freeze observed scores; they do not assert that posts remain available
        forever. Post text is removed after the configured retention period, initially 30 days.
        Enrollment identities, metric observations, audit decisions, disputes, and result versions
        are retained separately for reward accounting. Provider outages can delay reconciliation.
      </p>
      <h2>Product measurement</h2>
      <p>
        In live mode, this browser stores a random identifier to measure returning discovery visits
        and campaign and trading-link clicks. The visit identifier is separate from wallet and X
        sign-in records. Clearing site storage resets the identifier. Demo mode sends no product
        analytics.
      </p>
      <h2>Before the public pilot</h2>
      <p>
        The operator must confirm X display and retention requirements, configure the final
        retention period, and publish an operator contact and deletion-request process before
        enabling public live collection. This page describes the current implementation; it is not a
        claim that those launch checks have been completed.
      </p>
    </article>
  );
}
