# Current checkpoint

- 2026-11-14, Claude (orchestrator, parallel worktree agents authorized by owner). Session closed; no session agents running. Untracked `WARP.md`, `.playwright-mcp/` preserved in main checkout. Agent worktrees under `.claude/worktrees/` (merged work; safe to remove).
- **Merged this session (each Checks-green on exact head):** #468 T043 metrics exclusion (review MAJOR fixed+verified prior session), #470 TREASURY/DISPUTE separation (one independent review: 0 BLOCKER/MAJOR; MINORs → #471), #473 #471 fix pass (migration 202611130008 locked recheck, cross-tx race tests), #472 #372 index-lock doc, #474 #292 repeat revoke → 409 `GUILD_GRANT_ALREADY_REVOKED` + race tests + example revoke, #475 #79 testnet RPC / remote-test-DB refused under `RAID_ENVIRONMENT=production`, #476 #161 upload malformed body → 400, #477 #79 `USDC_FUNDING_ADDRESS` requires explicit `USDC_NETWORK` in production.
- **Closed:** #285, #273, #471. #294 remaining = items 6, 8 (owner). #79 flag-change audit was already done (#453).
- **Verified:** Checks on main `10fa1c1` green (after #468/#470). Tip after #477 dispatched at session end; recheck.
- **Rollout warning:** #477 refuses production boot with a funding address and no explicit `USDC_NETWORK` — audit non-staging env first (staging sets `devnet`).
- **Reviews:** all same-model agents; human review NOT VERIFIED.
- **No-decision work exhausted** across Ready board (#57, #49, #251, #253, #296, #352, #372, #275, #300, #290, #292 triaged; done-on-main comments posted). Not re-checked line by line: #352-4 assertions, #300-4, #275-2/4/7.
- **Owner decisions needed:** #372 party consent `proposalId`; #352-5 service principal; #300-2 throttle order; #275-4 consent expiry; #292-2 require explicit delegate expiry?; #294-6/8; #251/#253 remainders; #296-2 managed-updates cursor (design); #57/#49 (T078/UAT); prior list (#357, #331, #269, O02, O08, O05, O11/O12).
- **Owner actions (carried):** Docker VM inodes; staging stale `METEORA_*` incl. secret key; VM `compose.yaml` lacks `RAID_ENVIRONMENT`; `WORK_ACCEPTANCE_TAXONOMY_ID` unset; non-staging flag + `USDC_NETWORK` audit. `rpg-local` preview not running.
- **Tooling:** GitHub API rate limit is shared; agents must use one 300s poll loop and stop leftover pollers.
- **NOT VERIFIED:** UAT U001–U016, G01–G10, T077–T088/T096.
- **Next:** 1) confirm main tip Checks green; 2) owner decisions above unlock the remaining board.
