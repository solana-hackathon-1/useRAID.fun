# Fix branch report (`fix/everything`)

Record of the repository-wide review and the fix branch that followed it. It covers what was found, what changed, what is still unverified, and what an operator must do before deploying.

## Review

A read-only review of the whole repository (four commits, 2026-09-27 to 2026-09-30) produced 135 findings. Every medium-or-higher finding was re-checked by a second reviewer trying to refute it. No path to stealing funds or bypassing authentication was found. The serious findings were:

- **Settlement blockers:** raids that could never finalise, for example one malformed post URL, a post from a restricted account, or a review that a raider could restart.
- **X API budget exposure:** budget that any signed-in user could drain, failed requests that kept their full cost reservation, and one global rate-limit bucket by default.
- **Money gaps:** no release path for stuck USDC, payouts linear in view counts with no per-author cap, and first-writer-wins token metadata.
- **Verification gaps:** no tests for route handlers, the worker or signing code, and CI that skipped typecheck, lint and browser tests.

## What changed

| Area               | Change                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue and worker   | Exhausted jobs are dead-lettered and no longer block finalization. Pause, budget and 5xx errors do not use up attempts. Each scheduler step is isolated, so one failing raid cannot stall the queue. Time comparisons are UTC-explicit.                                                                                                                                                                                          |
| Finalization       | Restricted, suspended or unresolvable posts are classified and escalate instead of blocking. A non-qualifying review-time submission cannot restart the review, and extensions are capped. Raids past the 7-day search window get a hold with an admin "accept coverage" action.                                                                                                                                                 |
| X budget           | A failed request releases its reservation. X sign-in has its own budget. Public rate limits are per client. Mention searches are limited to enrolled authors. Stored posts are refreshed by staleness tier.                                                                                                                                                                                                                      |
| Money policies     | Each author's share of a funded raid is capped (default 25%). A raid's creator cannot join their own raid. An early end keeps measuring already-qualified posts until the original end. `X_TRACKING_V2_SETTLEMENT_ENABLED` now gates USDC and SOL allocation. Studio drafts formerly required creator approval (removed by DEC-2026-10-12-01). Sub-minimum payouts are refunded (SOL) or credited to the raider's ledger (USDC). |
| USDC operations    | Admins can credit a genuine late deposit with an audit entry, release the reserved pool of a hidden, held or suspended-creator raid, and see a ledger-versus-custody reconciliation. A withdrawal already paid on-chain cannot be rejected. A memo or transfer can be used only once.                                                                                                                                            |
| Token metadata     | Names and images are stored per raid, and the shared token row becomes authoritative only when it comes from market data.                                                                                                                                                                                                                                                                                                        |
| Auth and security  | Admin rights come from the env allowlist. Wallet sign-in is bound to the signer and rotates the session. An activity-free duplicate account is merged when X and a wallet are linked. CSP and HSTS headers, an image-host allowlist, and a media table replace inline images.                                                                                                                                                    |
| Database integrity | Triggers enforce ledger conservation, links and immutability. State columns have CHECK constraints, added unvalidated so existing rows are not rejected.                                                                                                                                                                                                                                                                         |
| Scoring            | Scoring v3 applies to new raids only: zero engagement scores 0, short near-duplicates are caught, and only the later copy is flagged.                                                                                                                                                                                                                                                                                            |
| Launchpad          | Its bugs are fixed and tested (rent reserve, expiring signed transactions, single-flight signing, key separation, image validation). It stays disabled: `launchpadsAvailable` is `false`.                                                                                                                                                                                                                                        |
| Frontend           | Admin lists are paginated and searchable, formatting is deterministic, the dead trade button is removed, and the layout survives a database outage. Tailwind is removed, checked against baseline screenshots.                                                                                                                                                                                                                   |
| Deploy             | The worker runs migrations before deploy and refuses to start on an out-of-date schema. The Docker image is multi-stage and runs as a non-root user.                                                                                                                                                                                                                                                                             |
| Testing and CI     | Chromium tests cover every page on desktop and mobile. CI runs typecheck, format, lint, a schema-drift check, audit, browser suites and a Docker smoke build. A shared database guard checks both name and host.                                                                                                                                                                                                                 |

## Nightly run

`useraid-nightly.timer` (a user systemd unit on the build machine) runs `scripts/nightly-tests.sh` at 02:00. The script checks out this branch in a separate worktree, starts the compose test database (`compose.test.yaml`, port 55432), runs typecheck, format, lint, unit and database tests, the build, the live flow and all three Chromium suites, and always shuts the database down afterwards. Logs and Playwright reports go to `~/.cache/useraid-nightly/logs/`. The summary is sent through `hermes send`.

## Verification state

- The last full database run passed 491 of 491 tests. Typecheck and formatting were clean. Lint reports 0 errors and 24 warnings.
- The nightly dry run passed (demo, live and studio Chromium suites), and the test database was stopped afterwards.
- Known gaps:
  - The claim that the regression tests for the high-severity findings fail on the old code was not re-checked.
  - Cold-start timeouts affect 2 or 3 page tests per run under heavy host load. They pass with a warm server. Playwright timeouts were raised afterwards, and the suites were not re-run end to end.
  - Telegram delivery from the nightly run was not confirmed: `hermes send` timed out on the build machine.
  - The stored image hosts could only be audited against an empty test database.

## Before deploying

1. Set `X_TRACKING_V2_SETTLEMENT_ENABLED=true`. Without it, Studio launches return 503.
2. Set `X_ADMIN_USER_ID`. Admin rights now come only from the env allowlist.
3. Run `npm run media:backfill`.
4. Change the Cloudflare Pages root directory. The coming-soon site moved out of `public/`.
5. Check the image allowlist against the image hosts stored in production.
6. After a production audit, ship the follow-up migration that validates the new state constraints.
7. Review `docs/operations.md` for the full operator checklist.
