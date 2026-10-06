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
