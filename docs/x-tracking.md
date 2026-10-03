# X tracking v2 rollout

Version 2 tracking is on unless `X_TRACKING_V2_ENABLED=false`, and settlement stays off unless `X_TRACKING_V2_SETTLEMENT_ENABLED=true`. Existing Raids keep tracking/rule/scoring version 1; migration does not rescore history or change paid transactions. Version 2 rules are copied when a Raid is created. Changing deployment flags does not convert existing Raids.

## Deployment gates

1. Run `npm run tracking:audit` with the intended deployment's existing database connection. This uses a read-only transaction and reports active Raid counts, legacy enrollments, pending/paid balances, signed transactions, and unallocated claims. Account for all obligations before enabling v2. No configured database means the audit has not happened.
2. Back up PostgreSQL and fee-wallet encryption keys. Apply committed additive migrations with `npm run db:migrate`. Run web and worker from the same release.
3. Run unit, dedicated-database integration, build, demo browser, and live-fixture browser checks. `useraid_test` is required for destructive test fixtures.
4. Independently verify X OAuth, search, lookup, returned metric fields, permitted display and storage/retention, and real cost. Existing $200 monthly budget and $180 cutoff remain. Reservation prices are existing conservative assumptions, not validated current provider prices. Leave `LIVE_COLLECTION_APPROVED=false` until this gate passes.
5. Enable `X_TRACKING_V2_ENABLED=true` on web and worker for new Raids. Observe contribution history, queue backlog, coverage, endpoint limits, finalization, and disputes. This alone does not enable v2 payment.
6. Only after audit, provider validation, a funded settlement smoke test, and restore verification, enable `X_TRACKING_V2_SETTLEMENT_ENABLED=true` with existing payout gates. Do not enable paid services for mocked tests.

Rollback: turn either v2 flag off to stop new v2 allocations/transfers. Existing signed financial transactions and launch receipts still reconcile in the worker, including paused launches and while launchpads are deferred; already broadcast transactions cannot be recalled. Keep additive schema and historical records. Do not roll back migrations or delete signed transactions.

## Behavior

- Join each Raid explicitly with verified X identity and wallet. Reward wallet and join time are immutable through application routes. Existing launch enrollment route delegates to Raid enrollment for v2.
- Manual submissions return stable submission ID, X post ID, and status. Wrong-author submissions never import or claim another author's post. Automatic discovery uses the same qualification pipeline. Global post IDs cannot move between Raids.
- Rule version 3 Raids require the frozen official handle in the author's own mention entities, without a hashtag. Automatic discovery assigns a post only when exactly one eligible enrolled Raid matches at post creation; overlapping posts require the raider to submit the URL to one Raid. Rule version 2 Raids retain their frozen mention-plus-hashtag rule. Reply/repost wrappers, posts before enrollment, and posts outside `[startsAt, endsAt)` are excluded.
- Append-only metric observations record actual observation time. Repeat processing of one successful job sample is idempotent. Missing metrics block completeness. Explicit unavailable responses preserve historical decisions; outages never imply deletion. Source text expires independently of financial history; a normalized-content hash keeps duplicate detection stable during permitted source-content expiry.
- Same-author exact normalized duplicates: earliest creation time, then post ID wins. Cross-author copies and near-duplicates (token-set Jaccard >= 90%, minimum 20 tokens each) are flagged, not automatically excluded. Admin decisions are audited.
- Score v2: `100 * (1 + log2(1 + likes + replies + reposts + quotes))` per post. Best ten posts across the whole Raid count; participant total rounds once. Equal post scores use creation time then post ID. Followers do not affect score.
- Active collection searches incrementally. The final search starts over the Raid's full time window to recover delayed indexing, with `start_time` clamped to X's 7-day search limit. A Raid still unfinished after 7 days is held as `COVERAGE_EXPIRED` until an administrator accepts partial coverage, which re-observes every known post and finalizes.
- Lookup errors are classified. Deleted posts are `POST_UNAVAILABLE`; protected, suspended or withheld posts are `POST_RESTRICTED`. Other unresolved lookups on a final pass are excluded as `LOOKUP_FAILED` after five attempts, so finalization always terminates; admins can refresh or restore them during review. An admin exclusion unblocks finalization of a post with incomplete data. Final refresh observes metrics after close. Search coverage describes completed provider queries, not a guarantee X indexed every post. Manual recovery remains available during review.
- Finalization requires full coverage, completed candidate lookups and jobs (including exhausted retries), valid metrics, and resolved flags/disputes. Result snapshots are append-only, enforced in PostgreSQL, with evidence references and no copied source text.
- Two-hour review starts when complete results publish. Routine refresh cannot change frozen score inputs. Result-changing audited corrections produce a new snapshot and restart two hours. Rejected disputes without changes keep the deadline. Missing-post disputes can be imported by an admin using the disputant's locked X identity.
- Review closure approves results only when blockers are clear. Settlement rechecks approval under the same Raid lock and binds one reward round to one approved snapshot. No scores or insufficient collected funds produce a held state, with no allocation.

## Fee accounting

V2 fee claims are tagged with their Raid before broadcast and retain that attribution through confirmation. Each claim can be allocated once. The final sweep completes after Raid close; allocation uses fees actually collected for that Raid, not an assertion of exact historical on-chain accrual at `endsAt`. Once final sweep completes, later vault accrual waits for a later Raid. Balances below the existing claim threshold remain in the vault.

Settlement consumes frozen scores and wallets. Existing cost deduction, 90/10 net split, deterministic remainder allocation, signed-transaction reconciliation, and sub-0.001 SOL carry-forward remain. Fee collection can continue while review is pending, but new payouts require review approval and both v2 flags.

Renewal waits until the previous v2 Raid is allocated or held and its fee sweep is complete. Held funds remain unallocated. Operations may explicitly assign held claims to an active later Raid of the same token, with an audit reason; this changes ledger attribution and does not send SOL. No arbitrary score or wallet edits are exposed.

## Interfaces

- `POST /api/raids/:id/enroll`: authenticated verified enrollment.
- `POST /api/raids/:id/submit`: authenticated URL submission for enrolled v2 users; accepted during active Raid or open review.
- `GET /api/raids/:id`: private/no-store response adds tracking health, leaderboard, top posts, result version/deadline, and requesting user's contributions/submissions/disputes.
- `POST /api/raids/:id/disputes`: enrolled owner; category, reason, optional X post ID.
- `POST /api/raids/:id/resolve`: admin only; audited clear/exclude/restore/refresh, missing-post import, dispute resolution/rejection, or held-claim reassignment.
- Operations shows blocked Raids, held funds, flagged/excluded posts, disputes, stale counts, job backlog, rate-limit resets, and last successful requests. Existing failed-job retry control remains.

## Local verification

Use an isolated PostgreSQL database named `useraid_test`. Run migrations, then:

```sh
RUN_DB_TESTS=true DEMO_MODE=false npm test
npm run typecheck
DEMO_MODE=true npm run build
npm run test:browser
npm run test:browser:live
```

Export that test database's `DATABASE_URL` for database and live-browser commands. Browser tracking fixtures use mocked contributions and real local enrollment/review routes; existing OAuth and wallet tests verify identity boundaries. No fixture spends X credits or transfers SOL. Live-provider behavior and funded transfers require separate rollout validation.

## Local visual check

`npm run tracking:preview` inserts clearly labeled sample Raid only when `DATABASE_URL` names an isolated `useraid_dev` database and `X_TRACKING_V2_ENABLED=true`. Open `http://localhost:3000/raids/local-tracking-fixture`; expect two scored raiders, two top posts, and one excluded duplicate among stored records. Status reads “Metrics delayed” because fixture never contacts X. Do not interpret fixture scores as live provider results. Local preview has no SOL launch or payout.
