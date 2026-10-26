@AGENTS.md
@RAID_BLUEPRINT_MAP.md

## Shared delivery process

Follow AGENTS.md and DEC-2026-10-26-01. Read CURRENT.md and MEMORY.md at session start; inspect actual Git state and preserve existing work. Read canonical blueprint sections on demand rather than importing the whole document.

Use one PR per task or user-visible vertical slice. At task end use the short PR self-check, genuine test-first RED/GREEN summary and CI link; no timing records, pin/evidence-only commits or new per-slice task/evidence files. Independent review is once per risky-boundary task (money/escrow, identity/auth, access grants, capacity/concurrency, migrations): one review plus one fix pass, BLOCKER/MAJOR fixes independently verified, MINOR/NOTE findings to follow-up. Other changes use CI plus self-check. Run the formal completion validator only at risky-boundary task closure. Missing UAT/business/release evidence stays NOT VERIFIED and does not block independent work.

Show a verified development preview only for browser-visible changes at task end; retain owner-requested previews. Stop only task-owned test resources automatically and use one cleanup checkbox. Update CURRENT.md only at session end, at most 30 lines, including any retained preview's owned identity/URL/stop command. Keep one active writer; Git actions and delegation require explicit authorization.
