# Shared workflow memory

Persistent project instructions for Codex/Claude handoffs. Read after CURRENT.md at session start. The canonical blueprint and active owner instructions remain authoritative; CURRENT.md owns mutable branch, task, server and verification state. This file is repository memory, not a claim about hidden assistant memory or an automatic scheduler.

## Historical preferences — superseded recording rules

DEC-2026-10-26-01 below supersedes the older per-slice review, timing, evidence, milestone-checkpoint and reporting requirements. Retained safety/cleanup and exact-source test-reuse rules still apply. Historical task-specific Git authority is not standing authorization.

## Owner preference — 10 October 2026

At independent-review time, run a timed self-evaluation, then show a verified development-server preview to the owner. Record this workflow in architecture and agent instructions. The owner explicitly requested push/merge of PR187 with these additions; that is task-specific publication authority, not standing permission for future merges or delegation. Canonical decision: DEC-2026-10-10-02, blueprint§24.8.

1. Reconcile exact source/working-tree identity and prior evidence before reviewing. Map scope to requirements and numbered task criteria; review actual code, tests, adverse boundaries and consuming-host documentation. Record UTC start/end, elapsed time, commands/results, findings and remaining gaps. Preserve genuine failures, retries and skips.
2. For a browser-visible change, run a task-owned development server with declared dependencies and synthetic fixtures. Use an available port, preserve existing services, verify relevant routes/actions and desktop/mobile behavior where applicable. Show a reachable URL and mode/source identity, retain appropriate screenshots/logs, and state what the preview cannot prove. Verify a production build separately when required.
3. Keep the requested preview running for owner inspection. Record container/PID, binding, URL and exact stop command in CURRENT.md. Stop only the owned resource when authorized/no longer needed; do not stop an unrelated listener or database.
4. Self-evaluation is SELF-EVALUATED, never an independent reviewer sign-off. A preview is not representative UAT or production acceptance. Keep missing criteria NOT VERIFIED and run the completion validator; do not fabricate PASS to make it accept. Obtain independent review when staffed/authorized and keep unresolved obligations visible after any owner-directed bounded merge.
5. Update CURRENT.md at milestones and before yielding. Continue dependency-ready issues one at a time using the recorded next step, preserving prior changes and respecting explicit Git/delegation authority.

## Owner preference — 11 October 2026

Optimize testing for every PR: select meaningful affected checks and mandatory gates; reuse evidence only when relevant source, dependencies, configuration and environment match. Do not repeat passing checks without a change or unresolved concern. Record actual run/reused/skipped checks and reasons. Automatically stop task-owned test containers and servers after testing, including failures/interruption, after preserving evidence. Cleanup failure is visible and blocks an aggregate success. Do not stop unrelated services or delete volumes/images/evidence. The owner's latest direction controls preview retention; for the current PR189 run the owner requests shutdown after testing. Apply DEC-2026-10-11-04, blueprint§24.8 and `.github/pull_request_template.md`.

## Owner staging continuation — 12 October 2026

DEC-2026-10-12-03 authorizes sequential bounded implementation and Git publication/merge to main for the staging pipeline without waiting for human UAT or recommendation. Preserve absent independent/UAT/business/release evidence as NOT VERIFIED; it blocks only its dependent acceptance/enablement, not independent implementation. Keep production/provider/financial gates and one-writer/no-delegation rules. Decision IDs for review preparation and test cleanup were reconciled to DEC-2026-10-10-02 and DEC-2026-10-11-04; historical reports retain original identifiers and hashes. Newer remote checkpoint work supersedes stale local next steps; reconcile before editing.

## Verified task-runner interruption cleanup — 15 October 2026

A finally block alone did not handle SIGTERM in a temporary Python verification runner: actual parent exit-15 left its owned PostgreSQL running. T013D2 retained that RED/source, manually recovered only the verified owned fixture, then added SIGINT/SIGTERM handlers, separate owned child sessions/process-group termination and verified-label shutdown in finally. Actual SIGTERM GREEN parent143/Runningfalse/automaticstop0; normal49/current consuming host also stop0. Use [the verified runner](../../planning/task-evidence/T013-review-reads/db-run.py) and [lifecycle evidence](../../planning/task-evidence/T013-review-reads/review.json) as the next task-harness starting point, renaming its exact task label/container/paths. Preserve unrelated resources and original failure evidence; SIGTERM verification is not a claim that SIGKILL can be trapped. This implements existing DEC-2026-10-11-04/§24.8, not a new owner policy.

## Owner preference — 24 October 2026

Keep `CURRENT.md` very small: current state, active resources, open findings and ordered next steps only. Replace superseded entries instead of appending; delete old handoff text that is no longer needed (history stays in git; evidence files under `planning/task-evidence/` are not handoffs and stay). Back up uncommitted content before pruning.

## Owner preference — 26 October 2026 (current process)

DEC-2026-10-26-01 adopts the owner-supplied lean delivery plan; see blueprint §§02.18/24.8. Product invariants, test-first development, server authorization, real-PG capacity races, default-off gates, one active writer and no live funds remain mandatory.

- One PR per task/user-visible vertical slice; no pin/evidence-only commits or extras beyond acceptance criteria.
- Once-per-task independent review only for money/escrow, identity/auth, access grants, capacity/concurrency or migrations. One review plus one fix pass; independently verify BLOCKER/MAJOR fixes, keep unresolved ones blocking their dependent scope; MINOR/NOTE findings become follow-up issues. Other changes use CI plus SELF-EVALUATED self-check. No automatic delegation.
- Evidence is the PR's CI link, test names and 1–3-line genuine RED/GREEN summary; relevant regression checks remain required. No timing, new committed planning/task-evidence files or per-slice docs/tasks reports. Preserve existing evidence.
- Numbered criteria are a reference checklist; formal packet validator only at risky-boundary task closure. Other implementation tasks close on green CI plus PR checklist. Missing UAT/business/release evidence stays NOT VERIFIED and blocks only dependent acceptance/enablement.
- Development preview only at browser-visible task end, verified with URL/source/mode/results. Retain owner-requested preview with exact owned-resource stop command. Automatically stop owned test resources after success/failure/interruption; one checkbox, surface failures, preserve unrelated resources.
- Import AGENTS.md plus map only; read blueprint domains on demand. CURRENT.md ≤30 lines, updated at session end only; back up uncommitted content before pruning.
- T013 built slices frozen as-is; final F2 re-review, UAT and staffing remain NOT VERIFIED follow-up. Next sequence: T016 → T020 → T021 → T023 → T024 → T022, simulated funds only. After one week assess PRs/task, doc:source ratio and S04 closures; no scheduler implied.
