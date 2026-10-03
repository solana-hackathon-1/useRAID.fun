# useRAID.fun

## Current release

Creator Studio supports X Campaigns and Existing Token Raids through one USDC-funded engine: target post previews, shared creator balance, impression calculator, duration, qualified contributors, review/disputes, manual payouts, and reports. Token Raids rank first. Legacy SOL Raids retain original rules. Run `npm run studio:preview` for isolated local testing at http://localhost:3007/studio-test. See [Studio setup, funding, CPA, and rollback](docs/creator-studio.md). Launchpads, trading, creator-fee payouts, and token creation are coming soon. The launchpad implementation below stays disabled by the release gate (`launchpadsAvailable` is `false` in `src/lib/release.ts`); only reconciliation of already-broadcast transactions keeps running. Studio launches and deposits need `X_TRACKING_V2_SETTLEMENT_ENABLED=true`; see the [operator checklist](docs/operations.md#operator-checklist) before deploying.

An attention MVP for Solana campaigns. Next.js + TypeScript + Tailwind, PostgreSQL + Prisma, and a separate PostgreSQL-backed collection worker.

## Preview locally

Requires Node.js 22. Run:

```sh
npm ci
cp .env.example .env
npm run db:generate
npm run dev
```

`npm run dev` listens on localhost only. To open the dev server from another device use `npm run dev:lan` and list that device's hostname in `ALLOWED_DEV_ORIGINS` (comma-separated, no scheme or port). `LOCAL_AUTO_APPROVE_CREATORS=true` approves every X sign-in as a creator for local testing; it is ignored when `NODE_ENV=production`, logs a warning when active, and bypasses Studio creator approval, so never rely on it outside development.

Open http://localhost:3000. `DEMO_MODE=true` renders illustrative campaigns without a database or provider credentials. All mutation, posting, trading, and analytics actions are disabled in demo mode. Demo names do not imply affiliation, and demo mint addresses do not identify the named assets.

## Database-backed mode

```sh
docker compose up -d db
# Set DATABASE_URL in .env and DEMO_MODE=false.
npm run db:migrate
npm run db:seed
npm run dev
# In a separate terminal:
npm run worker
```

The seed creates operating settings only. No fabricated posts or market prices enter the live database. For production, use `npm run build` then `npm start`.

Configure `NEXT_PUBLIC_APP_URL`, `X_CLIENT_ID`, `X_CLIENT_SECRET`, and optionally `X_ADMIN_USER_ID` (an immutable X user ID). Legacy `APP_URL` is a fallback; `ADMIN_X_IDS` (comma-separated) joins `X_ADMIN_USER_ID` in the administrator allowlist. The allowlist is checked on every request: administrators sign in with X (a wallet-only session never grants admin access), removing an id revokes access on the next request, and administrators can be suspended by another administrator, but never by themselves. Set one of the two variables before deploying or nobody can administer the site. Production requires an explicit HTTPS app origin. Register exactly `http://localhost:3000/api/auth/x/callback` locally, or `${NEXT_PUBLIC_APP_URL}/api/auth/x/callback` in production. Administrators bootstrap into the ADMIN role on sign-in and an ADMIN whose id left the allowlist is demoted at the next sign-in; other creators still require approval. OAuth uses `tweet.read users.read`; access tokens are used only for profile lookup and are not persisted. No refresh tokens are requested.

### Test Connect X locally

1. Supply the existing X credentials and `NEXT_PUBLIC_APP_URL=http://localhost:3000` in your local environment. Set `DEMO_MODE=false` and configure PostgreSQL. Do not run the collection worker for this test.
2. Run `npm run db:generate` and `npm run db:migrate`, then `npm run dev`.
3. Open `http://localhost:3000/creator`, click **Connect X**, and authorize in X. Expect **X Connected**, your display name and username.
4. Development diagnostics report configuration/database availability and the last successful authorization, profile lookup, and detected X ID. Before a successful connection, provider checks say **Not verified**. Production diagnostics require an authenticated administrator at `/admin`.
5. Click **Disconnect**. Your session, user, roles, and raid history remain; only the active profile connection is removed. Your immutable X login ID is intentionally retained for future sign-in. Sign out and connect the same X account again: it restores the same useRAID account.
6. Cancel authorization and retry; expect a clear cancellation notice. Replaying a callback or waiting longer than ten minutes must show an invalid/expired-state notice. Different X accounts cannot be attached to an existing signed-in account.

Existing users retain login identity and history after migration; they reconnect to populate verified profile metadata. The migration invalidates in-flight OAuth attempts, so restart any pending authorization. Legacy `/api/auth/login` forwards to the new flow; the old callback instructs users to retry. Disconnect is local unlinking, not revocation of the app in X settings. No user tokens are retained for later API calls. Development request logging excludes auth routes; production reverse-proxy/access logs must also omit OAuth callback query strings.

Live collection requires all three:

1. Provider credentials (`X_BEARER_TOKEN`).
2. `LIVE_COLLECTION_APPROVED=true` after completing the feasibility checklist.
3. Collection enabled by an administrator in Operations.

Never set the feasibility flag merely to make the UI appear live. Without verified access, attribution, permitted storage/display, and affordable usage, leave collection paused.

## pump.fun launches and rewards (deferred)

This section describes deferred infrastructure. Launch routes answer 503 and the UI says **Coming soon** while the release gate is closed. Reconciliation of launches that were already broadcast (`launch-reconcile`, `finance`) still runs in the worker; nothing else does. Launchpad fee rewards are not subject to the per-author cap, which applies to funded Raids only.

Launches are off by default. Set `DEMO_MODE=false`, complete X feasibility, enable collection in Operations, and configure a mainnet Solana RPC, Pinata JWT, versioned 32-byte AES key, separate operator and treasury addresses, and a funded worker signer. Set `LAUNCH_ENABLED=true` and `PAYOUT_ENABLED=true` only after those services work. The worker publishes readiness every minute; launch preparation and submission require a recent healthy heartbeat and at least 0.05 SOL in the operator wallet. The web service needs `OPERATOR_PUBLIC_KEY`; only the worker receives `OPERATOR_SECRET_KEY`. The web service needs `LAUNCH_KEY_1` (mint secrets), `FEE_SEAL_PUBLIC_1` and `LAUNCH_ASSET_KEY`; only the worker receives `FEE_SEAL_PRIVATE_1`, which opens the fee wallets the web service sealed. Keep old versioned keys configured after rotation until `npm run launch:rotate-keys -- --apply` has re-sealed every wallet.

Wallet login signs a five-minute challenge bound to the configured origin. Launch review names the fee recipient before wallet signing. useRAID submits only the reviewed pump.fun `create_v2` instruction and verifies finalized mint, curve, SOL pair, and creator-fee address before starting the 24-hour raid. No initial buy or extra platform launch charge is made. Users can resume prepared or submitted launches from `/launch`; expired signatures are rebuilt for the same mint.

Participants link both an X account and Solana wallet, then enroll from the token page. The worker claims curve and graduated-pool fees, waits for X collection coverage through each hour, scores qualifying posts, and pays eligible balances. Fee claims, network costs, platform allocations, signed payout transactions, and pending balances are recorded in PostgreSQL. Admin controls can pause new launches or payouts separately; a fee-recipient or accounting mismatch pauses the affected token.

Production validation must include a funded mainnet smoke test, chain fee verification across graduation, and restore testing for encrypted fee keys. The included tests mock providers or use a dedicated database and do not move SOL.

## X tracking v2

Tracking v2 is the default for new Raids: it is on unless `X_TRACKING_V2_ENABLED=false`, and a test pins that default. Raid-specific enrollment, verified contribution history, top-ten scoring (scoring v3 for new Raids), immutable review results, disputes, and post-review rewards all run through it. Existing Raids keep their frozen tracking, rule and scoring versions. Settlement is separate and **off** by default: `X_TRACKING_V2_SETTLEMENT_ENABLED=true` is required for any allocation, and for Creator Studio launches and deposits. Reconciliation of signed transactions runs in the worker whether or not the launchpad is gated or settlement is on. Two-administrator (four-eyes) approval of tracking decisions is deferred; decisions are audited instead. See [rollout, APIs, accounting, and validation](docs/x-tracking.md). Run `npm run tracking:audit` against the intended deployment before enabling settlement.

## Included

- Searchable discovery with Trending, Live, Rising, and New Raids views.
- Raid details, qualifying post feed, token profiles, attention history, and cached market snapshots.
- Creator sign-in with an approval request in Creator Studio, drafts, scheduled/immediate campaigns, and campaign termination. Approved creators only can save drafts, preview target posts and launch.
- Administrator moderation, creator suspension, job retries and dead-letter handling, audit log, quotas, budget thresholds, collection kill switch, pool release, expired-deposit crediting, USDC reconciliation, and paginated lists.
- Official X search and lookup adapters, exact mention/tag attribution, URL submission recovery, idempotent ingestion, cursor pagination, staleness-tiered metric refresh, classified lookup failures, coverage expiry, and deletion reconciliation.
- Scoring v3 for new Raids (100 x log2(1 + engagement), duplicate detection over unigrams and bigrams), with score v1 and v2 frozen on older Raids.
- Funded Raids pay in USDC (Studio) or SOL (legacy) with a per-author cap (`RAID_AUTHOR_CAP_BPS`, default 25%), a creator who cannot enroll in or be paid from their own Raid, minimum payouts, early-end measurement until the scheduled end, and a finalized-chain check on withdrawals.
- Ledger integrity enforced in PostgreSQL (append-only snapshots and ledger rows, linked money tables, checked state vocabularies added as `NOT VALID` constraints), a baseline schema migration, and a worker that refuses to boot on a stale schema.
- DEX Screener pair selection by liquidity and an exact-mint Jupiter link. Trading remains external.
- Deferred, gated off: SOL-paired pump.fun token launches with separate encrypted fee wallets, and hourly creator-fee rewards (90% raiders, 10% platform, balances below 0.001 SOL carry forward). Their reconciliation still runs for work already broadcast.
- Security headers with a Content-Security-Policy driven by `src/lib/image-hosts.ts`, wallet-rotation limits, X-only administrator sign-in, and media stored as `MediaAsset` rows.
- PostgreSQL job leasing, serialized per-raid claims, bounded retries, provider timeouts, conservative usage reservations, and spend-limit alerts in Operations.
- Browser-local anonymous visit/click identifiers. Operations includes campaign completion, repeat creators, returning visitors, and usage by raid.

## Structure

- `src/app`: public pages, creator/admin pages, and internal HTTP route handlers.
- `src/components`: responsive interface and forms.
- `src/lib`: domain rules, authorization, persistence, collection, queue, and provider adapters.
- `src/worker.ts`: scheduling, collection, reconciliation, and retention. It runs through `tsx` (a production dependency, as is `prisma` for pre-deploy migrations); the Docker runtime image ships `src/` and `tsconfig.json` for it.
- `prisma`: schema, committed migrations (additive only; the baseline is `202609270001_init`), and settings seed.
- `sites/coming-soon`: the static placeholder, published separately (see [docs/coming-soon-deploy.md](docs/coming-soon-deploy.md)).
- `tests`: deterministic domain, real PostgreSQL integration, and browser tests.
- `package.json` pins `next`, `react` and `react-dom` to patch ranges because this Next.js version has breaking changes between minors; the `deepmerge-ts` override in `package.json` forces Prisma's config loader onto 8.x; keep it unless a Prisma upgrade makes it unnecessary.
- `docs/operations.md`: deployment, operator checklist, spend, backup/restore, and pilot gates.
- `docs/verification.md`: the verification record of the `fix/everything` branch.

## Verification

```sh
npm run format:check
npm run typecheck
npm run lint
npm test                          # unit tests; database suites skip by default
npm run build
npx playwright install chromium
npm run test:browser               # demo suite; starts a demo server if none is running
```

Database tests need a **dedicated database named `useraid_test`** (the suite rejects any other name and any non-local host unless `ALLOW_REMOTE_TEST_DB=true`) and truncate its application tables. The repository ships a disposable one:

```sh
docker compose -p useraid-test -f compose.yaml -f compose.test.yaml up -d --wait db   # port 55432
export DATABASE_URL=postgresql://useraid:useraid@127.0.0.1:55432/useraid_test
npm run db:migrate
RUN_DB_TESTS=true DEMO_MODE=false npm test
```

After a production build, run the database-backed journeys against the same database:

```sh
DEMO_MODE=false npm run test:live
npm run test:browser:live
npm run test:browser:studio       # needs the Studio preview; run locally before release
```

`test:live` starts a temporary server on port 3001 and verifies the approved-creator journey: admin approval, a saved Creator Studio draft, the launch gate refusing without X credentials and funding, the public Raid, ending it, and the X connection UI. `test:browser:live` starts one on port 3006 with fixture records for tracking, standalone Raids, administration and security. `test:browser:studio` drives the sandbox Studio. None of them moves SOL or makes X requests. Provider tests mock network responses and incur no X charges. CI runs formatting, typecheck, lint, the audit check, the Docker image smoke test, migrations with a schema-drift diff, the full database suite, and the demo and live Playwright suites. The record of what was run on this branch is in [docs/verification.md](docs/verification.md).

## Operating defaults

Five approved creators; ten scheduled/active campaigns; 24-hour default campaigns; 72-hour maximum; 5-minute collection; 1-minute active market refresh; 30-second page refresh. X-read cadence: stored posts under a day old refresh every `X_REFRESH_MINUTES` (default 30) and older ones at four times that; Studio target-post lookups are limited to `STUDIO_LOOKUPS_PER_DAY` (default 300) per creator. X budget is $200/month with a $180 application cutoff and alerts at $140/$180. Hosting target is at most $100/month and must be validated against the chosen deployment.

Usage accounting reserves the maximum possible response cost before each X call, then settles to returned resources when successful. Failed requests retain their reservation. Daily provider deduplication discounts are deliberately not assumed. Recorded usage is a conservative operational ceiling, not an invoice. X identity reads are accounted for too.

`TRUSTED_IP_HEADER` must only name a single-value header that your trusted proxy overwrites (for example `CF-Connecting-IP` on Cloudflare; confirm which header your Railway edge sets, `X-Real-IP` or `X-Forwarded-For`). If the value holds a comma-separated list, only the last entry, the hop the proxy appended, is used, and it must be a valid IP address. With no trusted header, public request limits share one platform-wide ceiling per route; `/api/health` reports `rateLimitMode` as `per-client` or `shared`. Never trust arbitrary client-supplied forwarding headers.

## Current boundary

This implementation is locally testable, not a launched pilot. Real X OAuth/search behavior, actual spend, X display and retention approval, the official account, and live Jupiter routing still require operator/provider validation. No deployment or external account was created. The deployment configs do not provision paid services by themselves.

Swaps inside the app, reputation, paid discovery, and unrestricted public APIs remain out of scope.
