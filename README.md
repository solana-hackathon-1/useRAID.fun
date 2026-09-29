# useRAID.fun

An attention MVP for Solana campaigns. Next.js + TypeScript + Tailwind, PostgreSQL + Prisma, and a separate PostgreSQL-backed collection worker.

## Preview locally

Requires Node.js 22. Run:

```sh
npm ci
cp .env.example .env
npm run db:generate
npm run dev
```

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

Configure `NEXT_PUBLIC_APP_URL`, `X_CLIENT_ID`, `X_CLIENT_SECRET`, and optionally `X_ADMIN_USER_ID` (an immutable X user ID). Legacy `APP_URL` is a fallback; legacy `ADMIN_X_IDS` still joins the admin allowlist. Production requires an explicit HTTPS app origin. Register exactly `http://localhost:3000/api/auth/x/callback` locally, or `${NEXT_PUBLIC_APP_URL}/api/auth/x/callback` in production. Administrators bootstrap into the existing ADMIN role on sign-in; other creators still require approval. OAuth uses `tweet.read users.read`; access tokens are used only for profile lookup and are not persisted. No refresh tokens are requested.

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

## pump.fun launches and rewards

Launches are off by default. Set `DEMO_MODE=false`, complete X feasibility, enable collection in Operations, and configure a mainnet Solana RPC, Pinata JWT, versioned 32-byte AES key, separate operator and treasury addresses, and a funded worker signer. Set `LAUNCH_ENABLED=true` and `PAYOUT_ENABLED=true` only after those services work. The worker publishes readiness every minute; launch preparation and submission require a recent healthy heartbeat and at least 0.05 SOL in the operator wallet. The web service needs `OPERATOR_PUBLIC_KEY`; only the worker receives `OPERATOR_SECRET_KEY`. Both services need `LAUNCH_KEY_1` so the web service can encrypt a newly generated fee wallet and the worker can decrypt it for payouts. Keep old versioned keys configured after rotation until every associated wallet has been re-encrypted.

Wallet login signs a five-minute challenge bound to the configured origin. Launch review names the fee recipient before wallet signing. useRAID submits only the reviewed pump.fun `create_v2` instruction and verifies finalized mint, curve, SOL pair, and creator-fee address before starting the 24-hour raid. No initial buy or extra platform launch charge is made. Users can resume prepared or submitted launches from `/launch`; expired signatures are rebuilt for the same mint.

Participants link both an X account and Solana wallet, then enroll from the token page. The worker claims curve and graduated-pool fees, waits for X collection coverage through each hour, scores qualifying posts, and pays eligible balances. Fee claims, network costs, platform allocations, signed payout transactions, and pending balances are recorded in PostgreSQL. Admin controls can pause new launches or payouts separately; a fee-recipient or accounting mismatch pauses the affected token.

Production validation must include a funded mainnet smoke test, chain fee verification across graduation, and restore testing for encrypted fee keys. The included tests mock providers or use a dedicated database and do not move SOL.

## Included

- Searchable discovery with Trending, Live, Rising, and New Raids views.
- Raid details, qualifying post feed, token profiles, attention history, and cached market snapshots.
- Creator sign-in, affiliation submission, approval, drafts, scheduled/immediate campaigns, and campaign termination.
- Administrator moderation, creator suspension, job retries, audit log, quotas, budget thresholds, and collection kill switch.
- Official X search and lookup adapters, exact mention/tag attribution, URL submission recovery, idempotent ingestion, cursor pagination, metric refresh, and deletion reconciliation.
- Score v1 with rolling-hour scoring, normalized text deduplication, three-post and 20-point author caps, timestamped versioned snapshots, and freshness-aware momentum.
- DEX Screener pair selection by liquidity and an exact-mint Jupiter link. Trading remains external.
- SOL-paired pump.fun token launches signed by a connected Solana wallet, with separate encrypted creator-fee wallets and 24-hour launch raids.
- Hourly creator-fee rewards for verified X participants with proven Solana wallets. Claimed fees cover network costs, then split 90% to raiders and 10% to the platform. Balances below 0.001 SOL carry forward.
- PostgreSQL job leasing, serialized per-raid claims, bounded retries, provider timeouts, conservative usage reservations, and spend-limit alerts in Operations.
- Browser-local anonymous visit/click identifiers. Operations includes campaign completion, repeat creators, returning visitors, and usage by raid.

## Structure

- `src/app`: public pages, creator/admin pages, and internal HTTP route handlers.
- `src/components`: responsive interface and forms.
- `src/lib`: domain rules, authorization, persistence, collection, queue, and provider adapters.
- `src/worker.ts`: scheduling, collection, reconciliation, and retention.
- `prisma`: schema, committed migration, and settings seed.
- `tests`: deterministic domain, real PostgreSQL integration, and browser tests.
- `docs/operations.md`: deployment, spend, backup/restore, and pilot gates.

## Verification

```sh
npm run typecheck
npm test                          # unit tests; database suite skips by default
npm run build
npx playwright install chromium
npm run test:browser               # starts a demo server if none is running
```

For database tests, point at a **dedicated database named `useraid_test`**. The integration suite truncates application tables in that database:

```sh
DATABASE_URL=postgresql://useraid:useraid@localhost:5432/useraid_test npm run db:migrate
DATABASE_URL=postgresql://useraid:useraid@localhost:5432/useraid_test RUN_DB_TESTS=true DEMO_MODE=false npm test
```

After a production build, run the database-backed browser journey with the same isolated database:

```sh
DATABASE_URL=postgresql://useraid:useraid@localhost:5432/useraid_test DEMO_MODE=false npm run test:live
DATABASE_URL=postgresql://useraid:useraid@localhost:5432/useraid_test npm run test:browser:live
```

`test:live` starts a temporary server on port 3001 and verifies the existing campaign lifecycle. `test:browser:live` starts one on port 3006 with fixture launch and payout records; desktop and mobile checks cover the launch form, reward enrollment, balances, and payout links. Both use only the dedicated test database. Neither exercises a funded Solana transaction or makes X requests.

The suite rejects other database names. Provider tests mock network responses and incur no X charges. CI runs migrations, unit/integration tests, the production build, and a dependency audit.

## Operating defaults

Five approved creators; ten scheduled/active campaigns; 24-hour default campaigns; 72-hour maximum; 5-minute collection; 1-minute active market refresh; 30-second page refresh. X budget is $200/month with a $180 application cutoff and alerts at $140/$180. Hosting target is at most $100/month and must be validated against the chosen deployment.

Usage accounting reserves the maximum possible response cost before each X call, then settles to returned resources when successful. Failed requests retain their reservation. Daily provider deduplication discounts are deliberately not assumed. Recorded usage is a conservative operational ceiling, not an invoice. X identity reads are accounted for too.

`TRUSTED_IP_HEADER` must only name a header overwritten by your trusted proxy. With no trusted header, public request limits share a conservative bucket. Never trust arbitrary client-supplied forwarding headers.

## Current boundary

This implementation is locally testable, not a launched pilot. Real X OAuth/search behavior, actual spend, X display and retention approval, the official account, and live Jupiter routing still require operator/provider validation. No deployment or external account was created. The deployment configs do not provision paid services by themselves.

Swaps inside the app, reputation, paid discovery, and unrestricted public APIs remain out of scope.
