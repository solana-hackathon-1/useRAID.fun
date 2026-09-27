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

Configure `APP_URL`, `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_OFFICIAL_HANDLE`, and the immutable X user IDs in `ADMIN_X_IDS`. Register `${APP_URL}/api/auth/callback` as the X OAuth callback. Administrators bootstrap on sign-in; other users submit affiliation for manual approval. X OAuth requests only `tweet.read users.read`. User access tokens are not persisted.

Live collection requires all three:

1. Provider credentials (`X_BEARER_TOKEN`).
2. `LIVE_COLLECTION_APPROVED=true` after completing the feasibility checklist.
3. Collection enabled by an administrator in Operations.

Never set the feasibility flag merely to make the UI appear live. Without verified access, attribution, permitted storage/display, and affordable usage, leave collection paused.

## Included

- Searchable discovery with Trending, Live, Rising, and New Raids views.
- Raid details, qualifying post feed, token profiles, attention history, and cached market snapshots.
- Creator sign-in, affiliation submission, approval, drafts, scheduled/immediate campaigns, and campaign termination.
- Administrator moderation, creator suspension, job retries, audit log, quotas, budget thresholds, and collection kill switch.
- Official X search and lookup adapters, exact mention/tag attribution, URL submission recovery, idempotent ingestion, cursor pagination, metric refresh, and deletion reconciliation.
- Score v1 with rolling-hour scoring, normalized text deduplication, three-post and 20-point author caps, timestamped versioned snapshots, and freshness-aware momentum.
- DEX Screener pair selection by liquidity and an exact-mint Jupiter link. Trading is external; no wallets or funds are handled.
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
```

This starts a temporary server on port 3001, creates test identities and sessions, and verifies approval, draft creation, launch, fixture ingestion, public display, authorization, and campaign termination. It does not exercise real OAuth or make X requests.

The suite rejects other database names. Provider tests mock network responses and incur no X charges. CI runs migrations, unit/integration tests, the production build, and a dependency audit.

## Operating defaults

Five approved creators; ten scheduled/active campaigns; 24-hour default campaigns; 72-hour maximum; 5-minute collection; 1-minute active market refresh; 30-second page refresh. X budget is $200/month with a $180 application cutoff and alerts at $140/$180. Hosting target is at most $100/month and must be validated against the chosen deployment.

Usage accounting reserves the maximum possible response cost before each X call, then settles to returned resources when successful. Failed requests retain their reservation. Daily provider deduplication discounts are deliberately not assumed. Recorded usage is a conservative operational ceiling, not an invoice. X identity reads are accounted for too.

`TRUSTED_IP_HEADER` must only name a header overwritten by your trusted proxy. With no trusted header, public request limits share a conservative bucket. Never trust arbitrary client-supplied forwarding headers.

## Current boundary

This implementation is locally testable, not a launched pilot. Real X OAuth/search behavior, actual spend, X display and retention approval, the official account, and live Jupiter routing still require operator/provider validation. No deployment or external account was created. The deployment configs do not provision paid services by themselves.

Funded rewards, swaps inside the app, reputation, paid discovery, and public APIs remain out of scope.
