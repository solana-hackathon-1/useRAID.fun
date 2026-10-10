## Shared Codex / Claude Code handoff

Codex and Claude Code take turns on the same task using [docs/ai-handoff/CURRENT.md](docs/ai-handoff/CURRENT.md) as the shared checkpoint. It records progress; the canonical blueprint and existing instructions remain authoritative.

1. At every session start or resume, read `docs/ai-handoff/CURRENT.md` and `docs/ai-handoff/MEMORY.md` before task work, then read the applicable repository instructions and required blueprint sections.
2. Inspect `git status --short --branch`, staged and unstaged diffs, untracked files, and recent commits. Reconcile the checkpoint with actual files; it may be stale after an abrupt usage-limit interruption. Preserve existing work and distinguish prior changes from your own.
3. Continue the current bounded task from its recorded next step without repeating completed work. Re-run checks when needed to verify changed or uncertain state; prior results apply only to their recorded source and environment. If blocked, record the blocker and continue only independent work within the authorized scope.
4. Update `docs/ai-handoff/CURRENT.md` after each meaningful milestone and before yielding, ending a session, or reaching a usage limit when possible. Record timestamp/agent, task and status, branch/HEAD, changed files and unfinished changes, progress, decisions and their authority, exact tests/results (including failures or not-run checks), blockers, and ordered next steps. Keep prior evidence links and unresolved obligations visible; never include secrets.
5. Never discard unfinished user/agent changes or claim unverified work is complete. Do not reset, clean, overwrite, or stash away existing work to make a handoff easier. Preserve genuine RED/GREEN/REFACTOR evidence and required independent review; a handoff is not task acceptance.
6. Do not change branches, commit, or merge without explicit user authorization for that action. Continuing a task or switching agents does not authorize these actions. Leave checkpoint and implementation changes in the working tree when authorization is absent.
7. Use one active writer in this checkout. At a usage limit, the outgoing agent records the checkpoint if possible and stops; the user starts/resumes the other agent in this same checkout. The incoming agent follows steps 1–3 and records that it has taken over. These instructions do not provide automatic usage-limit detection, automatic agent launch, or permission to delegate.

## Review preparation and development preview

When work reaches independent review, first execute the self-evaluation and preview workflow in [blueprint section 24.8](RAID_AGENT_BLUEPRINT.md#248-review-preparation-and-development-preview) and [shared workflow memory](docs/ai-handoff/MEMORY.md). Record UTC start/end and elapsed time, exact source/working-tree identity, requirements checked, actual tests, skipped checks, findings and fixes. Reuse valid exact-source evidence; do not run arbitrary extra checks or weaken assertions to get green.

For browser-visible work, start a task-owned development server on an available port, verify the relevant pages/actions and show the owner its reachable URL, source, mode and observed results. Keep development preview distinct from production build verification. Preserve existing listeners and unfinished work; use dedicated synthetic fixtures and declared host dependencies. If a URL is container-only, provide a verified local forwarding URL or state the access limitation. Keep the owner-requested preview available until no longer needed and record how to stop only that owned resource.

Label author review SELF-EVALUATED. Self-evaluation and a preview do not supply independent criterion review, representative UAT, business approval or release gates. Missing independent evidence remains NOT VERIFIED; an explicitly owner-directed push/merge does not close the full issue or waive those obligations. Do not launch additional agents without explicit delegation authorization. Record review status, preview ownership and next steps in CURRENT.md before handoff.

# RAID blueprint authority

The canonical product and engineering specification is [RAID_AGENT_BLUEPRINT.md](RAID_AGENT_BLUEPRINT.md). Treat it as the authoritative RAID project document across every feature and domain. The active user's instructions and applicable system/developer instructions take precedence; preserve the Next.js rules below.

Before editing, read blueprint sections 00–04 and 13, then the relevant domain sections, section 33 role contract, section 34 milestone, and section 35 acceptance scenarios. Use the complete section map in [RAID_BLUEPRINT_MAP.md](RAID_BLUEPRINT_MAP.md) to find every domain.

For each change, explicitly map the user outcome to blueprint requirement/invariant IDs, affected entities, permissions, state transitions, existing repository files, and meaningful verification. Read related money, identity, access, and concurrency rules even when working in another domain. Inspect actual code and migrations; the blueprint describes intended behavior, not proven implementation.

Preserve LOCKED requirements. Apply DEFAULT choices unless a recorded decision replaces them. Keep DIRECTION, OPEN, and EXAMPLE distinct; never turn an unresolved decision or example into production policy. Record conflicts and implementation gaps rather than silently rewriting the specification or claiming completion. Implement only the assigned scope and its dependencies.

Use section 39 for completion and section 40 for task/handoff/decision records. Report actual verification and remaining gaps. When the owner changes a requirement, update the canonical blueprint's decision register and affected contracts/tests together. Agent-folder blueprint files are links to the canonical source; do not create divergent copies.

Every delivered internal feature (including auth) and external integration must satisfy R15/R16: stable replaceable contracts, explicit host dependencies, same-change documentation and a verified consuming example. Read [module reuse contracts](docs/raid-module-reuse.md).

Implementation changes require test-driven development: write a meaningful failing behavior test first, implement to green, then refactor with regression checks. Record genuine RED/GREEN/REFACTOR evidence in the task; do not weaken tests to bypass a contract.

Before claiming a project task complete, use its numbered criteria in [raid-agent-task-contracts.md](docs/raid-agent-task-contracts.md) and [planning/raid-task-contracts.json](planning/raid-task-contracts.json). Supply actual evidence and independent review for every applicable criterion; report missing evidence as unverified. Run the completion packet validator described in that guide. The canonical blueprint and active instructions retain precedence.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
