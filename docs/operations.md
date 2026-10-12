# Pilot operations

Current Creator Studio release and USDC funding/payment procedure: [creator-studio.md](creator-studio.md). [standalone-raids.md](standalone-raids.md) describes legacy SOL campaigns. Launchpad sections below describe deferred infrastructure that is gated off in code (`launchpadsAvailable` is `false`); the `.env.example` variables for it are inert, except that reconciliation of already-broadcast launches still runs. Configure X callback, collection access, approved USDC pricing, and custody wallet before accepting deposits.

## Operator checklist

Do these when deploying the `fix/everything` release, in order:

1. Set `X_TRACKING_V2_SETTLEMENT_ENABLED=true` (required for Creator Studio launches, deposits and settlement) and `X_ADMIN_USER_ID` (or `ADMIN_X_IDS`) on web and worker. Tracking v2 is already on by default.
2. Apply migrations (`npm run db:migrate`, run by the pre-deploy command), then run `npm run media:backfill` once to move inline images into `MediaAsset`.
3. Change the Cloudflare Pages **Root directory** to `sites/coming-soon` (and the build watch path to `sites/coming-soon/*`) when this release deploys; the placeholder moved out of `public/` and its deploy breaks otherwise. See [coming-soon-deploy.md](coming-soon-deploy.md).
4. Run `npm run tracking:audit` against production and account for every obligation it lists.
5. After that audit, ship the later migration that runs `VALIDATE CONSTRAINT` on the `NOT VALID` state checks from `202610020012_state_checks`. Existing rows were not validated by that migration, so validate only once the audit shows every status value is in its vocabulary.
6. Leave `LAUNCH_ENABLED` and `PAYOUT_ENABLED` false; launchpads are gated off in code regardless.
7. Leave `ACCOUNT_FOLDS_ENABLED` false (the default). Automatic merging of an activity-free duplicate account is not concurrency-safe yet (reproduced PostgreSQL deadlocks and a stale merge that deleted a just-connected X identity). With it off, signing in with an X account and a wallet that already belong to two different accounts is refused and both accounts stay unchanged; the user keeps using whichever account they signed in with first.

## Railway deployment

Create a PostgreSQL service, a web service using `railway.toml`, and a worker service using `railway.worker.toml`. Share database and public configuration between web and worker; keep `OPERATOR_SECRET_KEY` only on worker. Start with one replica each. Both the web and worker services run `npm run db:migrate` as a pre-deploy command (`prisma migrate deploy` holds a Postgres advisory lock, so concurrent runs serialise and the second is a no-op). At boot the worker also calls `assertSchemaCurrent()` and exits if the newest committed migration is not applied, so Railway's restart policy retries until the schema catches up; the runtime image ships `prisma/migrations` for this check. Use an HTTPS `APP_URL` and register the exact OAuth callback.

Set `DEMO_MODE=false`, `LIVE_COLLECTION_APPROVED=false`, and the real official account handle. Populate X credentials through Railway secrets, never repository files. Seed settings with `npm run db:seed`. Set `X_ADMIN_USER_ID` or `ADMIN_X_IDS` (immutable X user IDs) before deploying: they are the only source of administrators, checked on every request, so a DB-only ADMIN role without a listed ID no longer grants access. Sign in with X using a listed ID (a wallet-only session never grants admin access), use Operations for suspension and moderation. Connected X users create campaigns without administrator approval.

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

Keep `LAUNCH_ENABLED` and `PAYOUT_ENABLED` off until a dedicated mainnet RPC, Pinata, encrypted key backups, a distinct treasury, and a worker signer with at least 0.05 SOL are configured. Verify operator public/private key match and the mainnet genesis hash. Check worker readiness in Operations before launching. Never expose the worker's operator key through the web service. Key separation: the web service gets `LAUNCH_KEY_N` (mint secrets only), `FEE_SEAL_PUBLIC_N` (with `FEE_SEAL_VERSION`) and `LAUNCH_ASSET_KEY` (upload proofs). A new fee-wallet secret is sealed to the public key (X25519, AES-256-GCM), so only the worker, which alone holds `FEE_SEAL_PRIVATE_N`, can open it; the worker also keeps the legacy `LAUNCH_KEY_N` until every row is rotated. Generate a seal pair with `generateSealKeyPair` in `src/lib/launch-crypto.ts`. Back up the database and every key, then run `npm run launch:rotate-keys` on the worker (dry run) and `npm run launch:rotate-keys -- --apply`; it verifies each round trip against the stored fee address and mint before writing and prints counts only. Backups include sealed per-token fee keys and must be restored with their matching private keys. Keep previous versions configured after rotation until every associated wallet has been re-sealed.

Run one small authorized mainnet launch through wallet signing. Compare on-chain `create_v2` payer, mint, fee recipient, SOL pair, and metadata against review. Observe bonding-curve and post-graduation claims, X coverage through Raid end and review, each payout, treasury share, network reimbursement, and pending balances below 0.001 SOL. Compare the fee ledger with Solana transaction metadata. Pause payouts immediately if a fee recipient, network cost, or balance differs from the ledger.

Reserve at most ten scheduled/active campaign slots; creator access is self-serve. Publish a controlled post with the exact mention/tag; verify appearance within ten minutes under healthy provider conditions. Repeat with a submitted post URL. Confirm observed timestamps and partial/stale behavior during a deliberate provider interruption. Uncollected campaigns must display missing values, not fabricated metrics.

Exercise the kill switch while a campaign is active. New provider reservations must stop; an already-authorized in-flight request may finish. Turn collection back on only after confirming the cause of a pause. At 70% budget, review usage. At 90%, pause or reduce scope; never raise the $200 ceiling automatically.

Measure campaign completion and second campaigns by creator, attributable authors, returning discovery visitors, click-throughs, freshness, and cost per campaign. Clicks are not executed trades. Browser-local visitor identifiers are approximate and reset when storage is cleared.

## Launch finance behavior

- Reconciliation of already-broadcast work runs in the worker even while launchpads are deferred: a SUBMITTED launch gets `launch-reconcile`, a PREPARED launch with a prepared transaction is checked for an on-chain mint for 24 hours, and a LIVE or PAUSED launch with a SIGNED transaction gets `finance`. Nothing else runs. The worker needs `SOLANA_RPC_URL` (and `OPERATOR_*` for finance reconcile) while any launch has open work. `GET /api/launch/[id]` never reconciles.
- Only conditions that mean "stop moving money until a person looks" pause a launch (fee recipient or curve changed, unexpected network fee, simulation failure, insufficient fee-wallet balance, negative or missing claim). RPC and concurrency errors retry. A signed transaction that never lands is marked EXPIRED once the chain is 150 blocks past its last valid height and `getTransaction` finds nothing; payout rows return to READY. Resume is refused for ten minutes after a signed transaction.
- Signing is single-flight per launch behind an advisory lock; idempotency keys are `kind:round:wallet:sequence`.
- Each launch may permanently hold up to the rent-exempt minimum (about 0.00089 SOL) of operator SOL, topped up inside the payout or platform transaction and recorded in `TokenLaunch.rentReserveLamports`; it is never counted as fees. Keep the operator at 0.05 SOL or more.
- The network cost of a failed payout or platform transaction is reimbursed from that round's platform share. Third-party SOL or a pre-created wSOL account at the fee wallet is tolerated and counts as fees.
- v1 hourly rounds consume only claims made before the window closed (the last window also takes later claims). Fees are attributed to the window in which they were claimed.
- Finance and reconcile jobs run at lower priority than X collection; idle LIVE launches are polled hourly, busy ones every minute.

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

## Administrator access and review

Removing an ID from the allowlist revokes admin access on the next request and the stored role is demoted at that account's next sign-in. Administrators can be suspended by another administrator, never by themselves; suspending ends their sessions, and sign-in stays blocked while suspended. The migration that records how a session was issued (X or wallet) also deletes the sessions of existing administrators, so every administrator signs in with X again after deploy.

Conflict of interest: an administrator cannot review, correct, resolve disputes on, or carry held funds from or into a Raid they created or joined, and cannot review a post they authored. With a single administrator, a conflicted decision has to go to another administrator. Four-eyes approval (a second administrator confirming tracking decisions) is **deferred**: it needs a pending-decision workflow and at least two operators. Recommended scope when it is built is `carry-held` and exclude/restore on high-payout Raids; until then every decision is recorded in the moderation and contribution audit logs.

## Images and security headers

Studio draft images are stored as `MediaAsset` rows and served immutably from `/api/media/<id>`; token and profile images may only come from the hosts in `src/lib/image-hosts.ts`, which is also the `img-src` allowlist of the Content-Security-Policy set in `next.config.ts` (script and style inline allowances remain because pages carry no nonce; a nonce-based policy needs a proxy and fully dynamic rendering and is a later step). Add a host to that file before relying on a new image CDN. After deploying the `media_assets` migration run `npm run media:backfill` once to move inline `data:` images from Raid and Token rows into `MediaAsset`; until it runs, old rows keep rendering and a draft saved with an inline image is converted on save. Strict-Transport-Security is sent in production only. Check the wallet picker in Phantom and Solflare after changing the policy.

## Release gates

`npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test` and `RUN_DB_TESTS=true npm test` against isolated PostgreSQL, `npm run build`, `npm run test:live`, the three Playwright suites (`test:browser`, `test:browser:live`, `test:browser:studio`), the Docker image smoke test, a schema-drift check, and the dependency audit must pass. Repeat database restoration and collection-kill-switch exercises before the live pilot. Provider-backed acceptance remains separate from tests using mocked X responses.
