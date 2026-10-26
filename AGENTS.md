## Shared Codex / Claude Code handoff

Codex and Claude Code take turns on the same task using [docs/ai-handoff/CURRENT.md](docs/ai-handoff/CURRENT.md) as the shared checkpoint. It records progress; the canonical blueprint and existing instructions remain authoritative.

1. At every session start or resume, read `docs/ai-handoff/CURRENT.md` and `docs/ai-handoff/MEMORY.md` before task work, then load the applicable repository instructions and blueprint map. Read canonical blueprint sections on demand for the task (DEC-2026-10-26-01).
2. Inspect `git status --short --branch`, staged and unstaged diffs, untracked files, and recent commits. Reconcile the checkpoint with actual files; it may be stale after an abrupt usage-limit interruption. Preserve existing work and distinguish prior changes from your own.
3. Continue the current bounded task from its recorded next step without repeating completed work. Re-run checks when needed to verify changed or uncertain state; prior results apply only to their recorded source and environment. If blocked, record the blocker and continue only independent work within the authorized scope.
4. Update `docs/ai-handoff/CURRENT.md` only at session end; keep it at most 30 lines. Record timestamp/agent, bounded task/status, branch/HEAD, changed files, actual tests/CI, blockers, owned preview/stop command and ordered next steps. Preserve historical evidence links and unresolved obligations; never include secrets. Back up uncommitted content before pruning. Do not add per-slice task reports or new committed evidence directories.
5. Never discard unfinished user/agent changes or claim unverified work is complete. Do not reset, clean, overwrite, or stash away existing work to make a handoff easier. Preserve genuine RED/GREEN/REFACTOR evidence and required independent review; a handoff is not task acceptance.
6. Do not change branches, commit, or merge without explicit user authorization for that action. Continuing a task or switching agents does not authorize these actions. Leave checkpoint and implementation changes in the working tree when authorization is absent.
7. Use one active writer in this checkout. At a usage limit, the outgoing agent records the checkpoint if possible and stops; the user starts/resumes the other agent in this same checkout. The incoming agent follows steps 1–3 and records that it has taken over. These instructions do not provide automatic usage-limit detection, automatic agent launch, or permission to delegate.

## Lean review and delivery — DEC-2026-10-26-01

Apply [blueprint§02.18](RAID_AGENT_BLUEPRINT.md#0218-accepted-lean-delivery-process--26-october-2026), [§24.8](RAID_AGENT_BLUEPRINT.md#248-review-preparation-and-development-preview) and [shared memory](docs/ai-handoff/MEMORY.md). Use one PR per task or user-visible vertical slice, no pin/evidence-only commits, dependency order and no extras beyond acceptance criteria.

At task completion, use the short PR checklist: outcome, affected tests/CI link, failing test name plus 1–3-line RED/GREEN summary, risky-boundary review disposition and cleanup. Author self-check is SELF-EVALUATED; no timing records. Independent review is required once per task only for money/escrow, identity/auth, access grants, capacity/concurrency or migrations. UI/docs/other non-risky work uses green CI plus self-check. Maximum one review and one fix pass; independently verify BLOCKER/MAJOR fixes in that pass, and move MINOR/NOTE findings to follow-up issues. Unresolved BLOCKER/MAJOR findings block their dependent scope. Do not launch additional agents without explicit delegation authorization.

Provide a task-owned development preview only for browser-visible changes at task end: verify relevant routes/actions and desktop/mobile behavior where applicable; show reachable URL, source, mode and observed results. Preserve existing listeners; use synthetic fixtures and declared dependencies. Keep development preview separate from production build verification. Record access limitations, retain owner-requested previews and put their exact owned-resource stop command in the session-end checkpoint.

Missing required independent/UAT/business/release evidence stays NOT VERIFIED and blocks only its dependent acceptance or enablement. Continue unrelated dependency-ready work; do not invent PASS or approve your own required independent review.

# RAID blueprint authority

The canonical product and engineering specification is [RAID_AGENT_BLUEPRINT.md](RAID_AGENT_BLUEPRINT.md). Treat it as the authoritative RAID project document across every feature and domain. The active user's instructions and applicable system/developer instructions take precedence; preserve the Next.js rules below.

Load AGENTS.md and [RAID_BLUEPRINT_MAP.md](RAID_BLUEPRINT_MAP.md); read blueprint sections on demand for the task, role, milestone and acceptance scenarios. Do not import the entire blueprint. Read related money, identity, access and capacity rules before changing them.

For each change, explicitly map the user outcome to blueprint requirement/invariant IDs, affected entities, permissions, state transitions, existing repository files, and meaningful verification. Read related money, identity, access, and concurrency rules even when working in another domain. Inspect actual code and migrations; the blueprint describes intended behavior, not proven implementation.

Preserve LOCKED requirements. Apply DEFAULT choices unless a recorded decision replaces them. Keep DIRECTION, OPEN, and EXAMPLE distinct; never turn an unresolved decision or example into production policy. Record conflicts and implementation gaps rather than silently rewriting the specification or claiming completion. Implement only the assigned scope and its dependencies.

Use section 39 for completion and section 40 for task/handoff/decision records. Report actual verification and remaining gaps. When the owner changes a requirement, update the canonical blueprint's decision register and affected contracts/tests together. Agent-folder blueprint files are links to the canonical source; do not create divergent copies.

Every delivered internal feature (including auth) and external integration must satisfy R15/R16: stable replaceable contracts, explicit host dependencies, same-change documentation and a verified consuming example. Read [module reuse contracts](docs/raid-module-reuse.md).

Implementation changes require test-driven development: write a meaningful failing behavior test first, implement to green, then refactor with regression checks. Record failing test names and a 1–3-line RED/GREEN summary in the PR; run relevant regression checks after refactoring. Do not commit test logs or weaken tests to bypass a contract.

Use numbered criteria in [raid-agent-task-contracts.md](docs/raid-agent-task-contracts.md) and [planning/raid-task-contracts.json](planning/raid-task-contracts.json) as a reference checklist. Run the formal completion packet validator only at risky-boundary task closure. Other implementation tasks close on green CI plus the PR checklist. Keep missing UAT/business/release evidence NOT VERIFIED; closure does not grant production authority. The canonical blueprint and active instructions retain precedence.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Testing efficiency and container lifecycle — every PR

Apply DEC-2026-10-26-01, DEC-2026-10-11-04's retained cleanup policy and blueprint§24.8. Run meaningful affected checks plus mandatory gates. Reuse evidence only for matching source/dependencies/configuration/environment; do not repeat passing checks without material changes or unresolved concerns. State reused/skipped checks briefly in the PR. Automatically stop only task-owned test containers/servers on success, failure or interruption; preserve unrelated services, volumes, images and historical evidence. Use one cleanup checkbox; surface failures and retained previews. Follow the owner's latest preview direction. Use the repository PR template for every PR being handled.
