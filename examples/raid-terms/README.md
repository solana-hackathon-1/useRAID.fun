# Independent Raid work-loop host

Consumes the public `work-loop/terms`, `work-loop/contracts` `work-loop/storage` and `work-loop/engagement-storage` interfaces. Requires Node ≥22.12 and a new empty loopback PostgreSQL16 database named `raid_terms_example`; `DATABASE_URL` is its only configuration. This is a synthetic host with its own session/Guild-authority/reservation tables. It grants no RAID Guild recognition or production authority.

Copy this directory **dereferencing symlinks** to a separate directory (`cp -RL examples/raid-terms /tmp/raid-terms-host`). The declared source dependencies are work-loop, shared contracts, command-receipts, asset-registry, identity-locks, the synthetic fixture and the ten exact migrations linked here. Install with `npm ci`, then `DATABASE_URL=postgresql://.../raid_terms_example npm start`. Use a fresh empty database per run. Never point this setup at the application database.

The host verifies save, publication with one exact simulated reservation, write-disabled original replay, alternate scoped authorization and revoked-authority denial. It then creates an actual canonical HUMAN/session and exact-source consent, commits one ACCESS_PENDING engagement, recovers its receipt with writes/eligibility/funding off, denies a second engagement and rejects replay after session revocation without deleting active work. It imports no RAID auth, Prisma, Next, application singleton or credentials. It owns transaction commit/rollback and whole-transaction retry; PostgreSQL deadlock/serialization errors map to RETRY_TRANSACTION. Stop the owned database after testing; preserve unrelated resources. No package publication is required.

See [module contract](../../docs/raid-terms.md) for boundaries and limitations.

The minimal host declares the identity helper layout explicitly: Session and immutable Participant children, no X key, and empty wallet/link observation tables (no linking/folds). Root hosts use the full identity schema/layout. HostAcceptance supplies explicit version-bound synthetic consent/eligibility; HostReservation rechecks each exact version/reward vector under a row lock. No verified skill, operator, Party, live-fund or Root Guild authority is inferred. See [capacity contract](../../docs/raid-engagement-capacity.md).

The [admission extension](../../docs/raid-work-admission.md) additionally supplies its own current Founder Session and explicit application limit. It demonstrates nonbinding application/offer, stale-offer capacity denial, and another current candidate accepting the exact version while competing paths close. The simulated reservation/consent ports remain separate from actual live funding and skill approval.

The [submission extension](../../docs/raid-work-submissions.md) adds a fifth exact migration. The host starts the engagement itself through the guarded transition (start belongs to another task), then submits, receives a bounded revision request from the terms reviewer, resubmits and is accepted, which releases only that engagement's participant commitment. It also denies a non-reviewer.

The [closure extension](../../docs/raid-work-closure.md) adds a sixth exact migration. After acceptance the host reads its member's closure and unsettled claim, and operations closure of a still-pending engagement is refused until its accepted operational deadline.

The [amendment extension](../../docs/raid-work-amendments.md) adds a seventh exact migration. The host proposes a reward increase to the in-progress member through its own `AmendmentHost` (own reservation and consent tables), shows the effective terms unchanged until the member's exact-digest consent, refuses the Founder consenting for the member, then reads the agreed amount in the effective terms and the member's claim. It also shows a still-pending attempt cannot be replaced.

The [recommendation extension](../../docs/raid-work-recommendations.md) needs no migration. The host asks for a non-authoritative estimate from its own `UNEVALUATED_EXAMPLE` fixture rubric and compares the Founder's typed terms with it before saving, without the estimate affecting publication.

The [creation wizard extension](../../docs/raid-work-creation.md) adds an eighth exact migration (`simulated-reservations.sql`). The host builds typed terms from a wizard form with two reward assets, saves the draft, is refused publication because only one asset is covered by its simulated reserve (`FUNDING_REQUIRED`, no slot) and lists the unchanged draft.

The [notification extension](../../docs/raid-notifications.md) adds the ninth and tenth exact migrations (`notifications.sql`, `notification-safety.sql`). It initializes dispatch against the empty host before generating business events. After the work loop the host runs the outbox dispatcher twice (no duplicate), reads its member's own fixed-text notification and is refused when another person tries to mark it read. An existing host with processed dispatch markers retains its pending backlog through the safety migration; a first enabled host suppresses already committed history once.

Reservation binding migration: `migrations/reservation-binding.sql` validates existing synthetic coverage before binding references. `WorkHost.reserveSimulatedFunding` still returns its host-owned reference; canonical publication and replacement record it against the exact slot/version/reward vector. A host must not insert the canonical reservation itself. No live balance is implied.

Public feed (#R08): after publication the host reads the live Raid back through `readWorkFeed` and asserts it is a safe card (simulated funding label; no reviewer, reservation, creator or deliverables). See [public Raid feed](../../docs/raid-work-feed.md).

Work-loop metrics (#T043): after the loop the host reads the operator metrics and checks they stay simulated, per asset, with `paid` never inferred and no account ids. See [work-loop metrics](../../docs/raid-work-metrics.md).

Application offers (#239): `migrations/offer-application-index.sql` indexes offers by application, and the host's `AcceptanceHost.authorizeOfferIssuer` answers, as an account (no session), whether the offer's issuing Founder still holds current Guild authority and is not suspended. Acceptance with an offer fails closed without it.
