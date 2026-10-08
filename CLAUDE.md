@AGENTS.md
@RAID_AGENT_BLUEPRINT.md
@RAID_BLUEPRINT_MAP.md

## Shared Codex / Claude Code handoff

Codex and Claude Code take turns on the same task using [docs/ai-handoff/CURRENT.md](docs/ai-handoff/CURRENT.md) as the shared checkpoint. It records progress; the canonical blueprint and existing instructions remain authoritative.

1. At every session start or resume, read `docs/ai-handoff/CURRENT.md` before task work, then read the applicable repository instructions and required blueprint sections.
2. Inspect `git status --short --branch`, staged and unstaged diffs, untracked files, and recent commits. Reconcile the checkpoint with actual files; it may be stale after an abrupt usage-limit interruption. Preserve existing work and distinguish prior changes from your own.
3. Continue the current bounded task from its recorded next step without repeating completed work. Re-run checks when needed to verify changed or uncertain state; prior results apply only to their recorded source and environment. If blocked, record the blocker and continue only independent work within the authorized scope.
4. Update `docs/ai-handoff/CURRENT.md` after each meaningful milestone and before yielding, ending a session, or reaching a usage limit when possible. Record timestamp/agent, task and status, branch/HEAD, changed files and unfinished changes, progress, decisions and their authority, exact tests/results (including failures or not-run checks), blockers, and ordered next steps. Keep prior evidence links and unresolved obligations visible; never include secrets.
5. Never discard unfinished user/agent changes or claim unverified work is complete. Do not reset, clean, overwrite, or stash away existing work to make a handoff easier. Preserve genuine RED/GREEN/REFACTOR evidence and required independent review; a handoff is not task acceptance.
6. Do not change branches, commit, or merge without explicit user authorization for that action. Continuing a task or switching agents does not authorize these actions. Leave checkpoint and implementation changes in the working tree when authorization is absent.
7. Use one active writer in this checkout. At a usage limit, the outgoing agent records the checkpoint if possible and stops; the user starts/resumes the other agent in this same checkout. The incoming agent follows steps 1–3 and records that it has taken over. These instructions do not provide automatic usage-limit detection, automatic agent launch, or permission to delegate.
