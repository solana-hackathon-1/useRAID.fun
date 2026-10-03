# Pilot operations

Current Creator Studio release and USDC funding/payment procedure: [creator-studio.md](creator-studio.md). [standalone-raids.md](standalone-raids.md) describes legacy SOL campaigns. Launchpad sections below describe deferred infrastructure. Configure X callback, collection access, approved USDC pricing, and custody wallet before accepting deposits.

## Railway deployment

Create a PostgreSQL service, a web service using `railway.toml`, and a worker service using `railway.worker.toml`. Share database and public configuration between web and worker; keep `OPERATOR_SECRET_KEY` only on worker. Start with one replica each. The web deployment runs committed migrations; deploy it before starting a new worker version. Use an HTTPS `APP_URL` and register the exact OAuth callback.

Set `DEMO_MODE=false`, `LIVE_COLLECTION_APPROVED=false`, and the real official account handle. Populate X credentials through Railway secrets, never repository files. Seed settings with `npm run db:seed`. Sign in using an ID listed in `ADMIN_X_IDS`, then approve invited creators based on submitted affiliation evidence.

X request accounting: a request that fails without a billable response (transport failure, non-2xx) releases its reservation to zero; a timeout keeps it because X may still have billed. Sign-in lookups are tracked separately (`x-identity`) under an admin-editable daily sign-in limit and the monthly hard cap, so an exhausted collection cutoff never blocks sign-in; the gap between the cutoff and the monthly budget is the headroom reserved for sign-ins. Rule 3+ mention searches add a persisted `from:<enrolled author ids>` filter (limited by `X_SEARCH_QUERY_MAX_CHARS`, falling back to the unfiltered query when too long) and skip X entirely for raids with no enrollments. Stored posts are re-read by staleness tier: posts under a day old every `X_REFRESH_MINUTES` (default 30), older posts every four times that, while final passes still read everything. A post read costs 0.5 cents, so the $180 cutoff is about 36,000 reads; the 30-minute tier cuts re-read volume roughly sixfold for recent posts and 24-fold for older ones.

Set the X developer-console budget independently of the application budget. Disable unlimited auto-recharge. Configure Railway spend notifications within the $100 hosting allocation. Configure your monitoring service to check `/api/health`; it checks database availability, not X availability. Inspect collection errors and stale observation times in Operations. Worker errors are structured logs containing job identity and a sanitized error, never tokens or provider response bodies.

## Feasibility gate — must pass before live collection

- Confirm control of the configured X account and verify OAuth identity/callback behavior.
- Verify rule version 3 search with `@officialhandle -is:retweet -is:reply` finds original posts and quotes without a hashtag; verify repost wrappers and replies are excluded. Verify earlier rule versions still use `@officialhandle #raid_unique`.
- Check negative cases: wrong mention, pre-start/post-end timestamps, overlapping Raid enrollments, and rule version 2 wrong or multiple registered tags.
- Check lookup counters, pagination, cursor resumes, rate-limit reset, invalid credentials, and explicit deletion responses using the actual API account.
- Confirm storage, redisplay, attribution, deletion, and retention requirements for the chosen X agreement. Set `X_RETENTION_DAYS` accordingly and update the public privacy page; add the operator's contact and deletion-request process.
- Run a controlled campaign. Compare observed provider billing with `ProviderUsage`; decide whether the $200 budget supports the expected pilot volume. Reservations do not rely on X's soft daily deduplication guarantee.
- Verify that a Jupiter link opens the intended output mint on the current Jupiter UI. Test at least two real pilot token mints. Do not execute a trade as part of verification.
- Confirm market cap is not substituted with FDV, that pair choice is correct, and no-pair results display unavailable.
- Only then set `LIVE_COLLECTION_APPROVED=true` and enable collection in Operations.

## Controlled pilot acceptance

Keep `LAUNCH_ENABLED` and `PAYOUT_ENABLED` off until a dedicated mainnet RPC, Pinata, encrypted key backups, a distinct treasury, and a worker signer with at least 0.05 SOL are configured. Verify operator public/private key match and the mainnet genesis hash. Check worker readiness in Operations before launching. Never expose the worker's operator key through the web service. Both web and worker need the active `LAUNCH_KEY_N`; preserve previous versions through rotation. Backups include encrypted per-token fee keys and must be restored with their matching environment keys.

Run one small authorized mainnet launch through wallet signing. Compare on-chain `create_v2` payer, mint, fee recipient, SOL pair, and metadata against review. Observe bonding-curve and post-graduation claims, hourly X coverage, each payout, treasury share, network reimbursement, and pending balances below 0.001 SOL. Compare the fee ledger with Solana transaction metadata. Pause payouts immediately if a fee recipient, network cost, or balance differs from the ledger.

Invite five approved projects and reserve at most ten scheduled/active campaign slots. Publish a controlled post with the exact mention/tag; verify appearance within ten minutes under healthy provider conditions. Repeat with a submitted post URL. Confirm observed timestamps and partial/stale behavior during a deliberate provider interruption. Uncollected campaigns must display missing values, not fabricated metrics.

Exercise the kill switch while a campaign is active. New provider reservations must stop; an already-authorized in-flight request may finish. Turn collection back on only after confirming the cause of a pause. At 70% budget, review usage. At 90%, pause or reduce scope; never raise the $200 ceiling automatically.

Measure campaign completion and second campaigns by creator, attributable authors, returning discovery visitors, click-throughs, freshness, and cost per campaign. Clicks are not executed trades. Browser-local visitor identifiers are approximate and reset when storage is cleared.

## Failure and recovery

- **429:** Jobs respect the provider reset time, with a minimum backoff. Do not replay jobs to bypass provider limits.
- **401/403:** Correct credentials/access before retrying failed jobs. Cached metrics remain labeled partial/stale.
- **Budget exhausted:** Review the provider console and usage ledger. The worker must not bypass the cutoff to restore freshness.
- **Search cursor invalid:** Pause the affected campaign collection, record the incident, clear `nextToken`, `pendingNewestId`, and `searchEndAt` while retaining `sinceId`, and retry. Post IDs prevent duplicates.
- **Worker crash:** Expired job leases can be reclaimed after ten minutes. A stale lease cannot acknowledge another worker's job. Jobs for a raid are serialized; retries are idempotent.
- **Ambiguous financial transaction:** If a signed claim or transfer expires without a definitive chain receipt, the token pauses. Inspect its recorded signature and raw transaction against an archival mainnet RPC. Resume only when the receipt becomes definitive; an unknown receipt pauses again and never triggers a replacement transfer. A confirmed failed transaction records its network fee and pauses until the cause is resolved.
- **Eight failed attempts:** Inspect the error in Operations, fix its cause, then retry with an audit reason.
- **Moderation:** Hide the post/campaign and record why. Post moderation invalidates historical baselines to avoid presenting an unqualified comparison.
- **Retention:** The worker clears expired post content and reconciles ended-campaign posts daily within retention. Metrics spanning retained content are not a permanent archive. Confirm provider rules before launch.

## Backup and restore

Enable managed daily backups. Before the pilot, restore into a new isolated database and verify counts and representative campaigns. Never practice a restore against production.

```sh
pg_dump "$DATABASE_URL" --format=custom --no-owner --file=raid-backup.dump
# RESTORE_DATABASE_URL must point to an empty isolated database.
pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --no-privileges raid-backup.dump
psql "$RESTORE_DATABASE_URL" -c 'SELECT count(*) FROM "Raid"; SELECT count(*) FROM "Post";'
```

Encrypt backup storage and restrict access because it includes sessions and creator identities. Delete the temporary dump according to your retention policy. Do not log database URLs.

## Release gates

`npm run typecheck`, `npm test` against isolated PostgreSQL, `npm run build`, `npm run test:browser`, and dependency audit must pass. Repeat database restoration and collection-kill-switch exercises before the live pilot. Provider-backed acceptance remains separate from tests using mocked X responses.
