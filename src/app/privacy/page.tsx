export default function Privacy() {
  return (
    <article className="prose">
      <h1>Data and privacy</h1>
      <p>
        useRAID stores the X user ID and handle of signed-in creators, submitted project
        affiliation, campaign information, and a server-side login session. Sign-in requests read
        access only. Access tokens are used for identity lookup and are not retained.
      </p>
      <h2>Public campaign data</h2>
      <p>
        We collect attributed public X posts, author IDs, timestamps, and public engagement counts.
        A scheduled reconciliation checks retained posts for explicit deletion responses. Post text
        is removed after the configured retention period, initially 30 days. Provider outages can
        delay reconciliation.
      </p>
      <h2>Product measurement</h2>
      <p>
        In live mode, this browser stores a random identifier to measure returning discovery visits
        and campaign and trading-link clicks. It is not connected to a wallet. Clearing site storage
        resets the identifier. Demo mode sends no product analytics.
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
