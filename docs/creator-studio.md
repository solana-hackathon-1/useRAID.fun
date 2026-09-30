# Creator Studio v1

X Campaign and Existing Token use one campaign engine. Launch Token remains Coming soon. Verified X users can save and launch without legacy creator approval; suspensions and global campaign limits still apply.

## Local walkthrough

Run `docker compose up -d db`, then `npm run studio:preview`. Open http://localhost:3007/studio-test and enter test Studio. It supplies a fixture X identity, verified test wallet, and 1,000 test USDC. Create Raid → X Campaign → name → any valid public X status URL → Preview → target/budget → duration → accept test terms → Fund & Launch. Manage page lets you simulate a contributor, reach target, and fast-forward test review. Operations confirms test reward receipts. Balance supports test deposits and withdrawal requests.

Sandbox cannot run in production: requires development runtime, explicit flag, localhost canonical URL, and database named `useraid_studio_test`. Preview binds loopback. Separate `.next-studio` output, session cookie, and database avoid production data and server conflicts. All fake financial entries use sandbox network. No real X calls, signatures, or transfers occur. Fixtures must never be presented as real metrics.

## Deployment configuration

Apply `npm run db:migrate`; build web and run web plus worker. Set `DEMO_MODE=false`, canonical HTTPS `NEXT_PUBLIC_APP_URL`, matching X OAuth callback in X developer portal, X OAuth credentials, `X_BEARER_TOKEN`, verified provider access to contributor `impression_count`, `LIVE_COLLECTION_APPROVED=true`, and Operations collection enabled. Configure HTTPS `SOLANA_RPC_URL`, `USDC_NETWORK=mainnet`, signer-capable platform `USDC_FUNDING_ADDRESS`, and operator-approved integer `USDC_MICROS_PER_1000_IMPRESSIONS`. Leave rate empty until pricing is approved. Funding stays disabled; drafts remain available. Studio funding does not need launchpad or automated SOL payout switches. Restart web and worker after configuration changes.

USDC has six decimals. Available/reserved ledger is append-only and separated by network. Wallet-signed deposits require finalized transferChecked to canonical USDC mint and platform associated token account, exact amount, verified source signer, time-bounded intent, unique signature, and memo `useRAID:usdc:<transferId>`. Single receipt cannot credit twice. SOL pays deposit network fees, not Raid budget. Operator pays outgoing network fees; platform campaign fee is zero in v1.

Launch freezes quote and network, atomically reserves available funds, and validates all public targets. Concurrent launches/withdrawals cannot overspend. Quote changes require creator review. Target posts added while live qualify only for contributions created after addition. Drafts survive deposit return and provider outages. Target views never count as participant delivery.

## Qualification, review, CPA

Contributor joins with verified X and wallet before posting. Own-author original post linking a selected target or quote of that target, plus official mention, must be inside campaign window. Reposts, replies, wrong author, duplicates, retroactive targets, and unrelated content do not qualify. Attention leaderboard uses best ten qualifying posts; USDC rewards use all qualifying contributor impressions. Missing views mean unavailable, never fabricated zero. Campaign closes on target or duration. Final collection, two-hour disputes, and corrections precede immutable reviewed allocation. Unknown views or unresolved issues hold allocation.

Earned pool = budget × min(reviewed impressions, target) / target. Each participant receives earned pool × their qualifying impressions / all qualifying impressions. Integer rounding dust and unearned pool return to creator balance. Over-delivery never enlarges budget. Content CPA = reviewed earned pool / qualifying original-or-quote posts. CPM = reviewed earned pool × 1,000 / reviewed impressions. These measure observed delivery, not guaranteed reach, unique viewers, conversions, or purchases. Campaign CSV labels provisional data and suppresses USDC CPA/CPM until reviewed, with complete views.

## Manual payouts

After allocation, Operations lists USDC rewards and withdrawals with network, mint, destination, amount, and required memo. Operator reviews, sends transferChecked from platform wallet to recipient associated token account, includes exact memo, then verifies finalized receipt. App never holds outbound signing key. Pending withdrawal reserves available funds; rejection needs audit reason and restores funds. Reward payments do not credit creator balance. Old SOL Raids preserve old funding, qualification, and payment paths. Keep funds reserved for unpaid liabilities; manual payout ops must reconcile custody wallet against outstanding balances and transfers before withdrawing platform capital.

## Rollback

Migration adds fields/tables and defaults legacy campaigns to Studio version zero/SOL; no existing data rewrite. Disable live funding by clearing rate and deployment gate. Do not drop new tables or delete balance entries. Finish/reconcile pending deposits and transfers before changing network or platform wallet. New network does not expose old-network available funds. Reverting application to older revision stops new Studio launches but cannot settle existing USDC obligations: retain current worker/payment operations until all obligations resolved.
