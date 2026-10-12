# T006 B1 — independent review, clean local CI and criterion disposition

Recorded 2026-10-10 by Claude Sonnet 5.5 after Codex hit its usage limit. Base `main` `66d6a3a`, uncommitted working tree. Structured record: [verification.json](../../planning/task-evidence/T006-wallet-links-b1-final/verification.json); source hashes: [source-manifest.json](../../planning/task-evidence/T006-wallet-links-b1-final/source-manifest.json). Maps to R04/R13/R15/R16, I05/I10/I13, AC01 (partial), AC02/AC75; blueprint §§07, 13, 24.6–24.7, 28, 32, 35, 39–40. No schema, migration, route, UI, flag or blueprint change.

## 1. B1 independent review

Verdict **ACCEPTED WITH CONDITIONS** — [report](../../planning/task-evidence/T006-wallet-links-b1-review/REPORT.md). Reviewer: a separate non-author Claude subagent working in an isolated copy with its own PostgreSQL container. **Limits, stated plainly:** it is not the Codex reviewer that was already looking at the frozen manifest (that report has not landed), and it shares a model family with the continuing author. Treat this as an independent-instance review, not as the Codex acceptance.

Reviewer-run: `tsc` 0; 7 focused suites 124/124; full suite 1069 across 84 files; 31 mutations, 27 killed, survivors M01 (equivalent), M11, M13, M26.

| Finding / condition                                                                                                                                          | Disposition                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 isolation check untested on the ABSENT path (M26)                                                                                                         | Closed test-first. Mutation RED (2 failures) → GREEN.                                                                                                        |
| F2 post-lock owner recheck untested/possibly unreachable (M13)                                                                                               | Closed test-first with an alternate-port test (mutation RED, 1 failure → GREEN). Doc reworded: defense in depth, **not shown reachable on real PostgreSQL**. |
| F3 session-authority undocumented                                                                                                                            | Closed: section added to [raid-wallet-links.md](../raid-wallet-links.md).                                                                                    |
| F4 stale manifests                                                                                                                                           | Closed by this record; older manifests stay historical.                                                                                                      |
| `next-env.d.ts`                                                                                                                                              | Excluded; uncommitted generated drift.                                                                                                                       |
| B2 obligations (DB-read session, server clock, durable audit, session invalidation, default-off flag, T007 network binding, suspended-account revoke policy) | Kept open.                                                                                                                                                   |

F1–F3 fixes were written and verified by the continuing author and were not re-reviewed by the reviewer.

## 2. Clean final local CI

Unmodified `scripts/local-ci.sh` in a fresh clone of `66d6a3a` overlaid with the working tree (every owned file byte-equal to the main checkout). All **22/22** steps exit 0: planning 32, format, types, lint, security, 22-migration deploy, drift none, vitest **1072 tests, 0 failures/errors/skips**, docker build/runtime, browsers demo 49 pass/1 skip, Studio 44 pass, live 38 pass/6 skips, production build, live-flow. This replaces Codex's failed first aggregate for the current tree (that record stays). Local isolated run only — not hosted CI, not a merge approval.

## 3. T006 criteria

`python3 scripts/verify-raid-completion.py T006 …` → exit 1, all 27 NOT VERIFIED (expected, [log](../../planning/task-evidence/T006-wallet-links-b1-final/completion-validator.log)). B1 supplies partial evidence only:

| Criteria                              | What B1 evidences                                                                               | Why still NOT VERIFIED                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| C19 TDD                               | Genuine RED→GREEN→REFACTOR for credentials, rotation isolation, session authority, review fixes | Covers B1 scope only; B2/B3 not written                                     |
| C20 / C21                             | Alternate-port contract tests; own-installed consumer host runs                                 | Session-authority helper not exercised by the example; B2 host absent       |
| C22                                   | Clean 22-step local CI                                                                          | Not hosted; no B2/UAT/browser coverage of new behavior                      |
| C06, A01, A02                         | Participant mapping, resolver; second-wallet **storage**                                        | No sign-in through a linked wallet; no capacity table (A02 cannot be shown) |
| C04, C14, W01–W03                     | Fail-closed resolve/revoke, authority helper                                                    | No X-confirmed link command, recovery/merge review (O11/W03)                |
| C08, C10, C12, C15                    | Not touched / out of scope                                                                      | Receipts (T019), recovery, flag/ops evidence                                |
| C13, C17                              | None (no UI)                                                                                    | B3 UI and human UAT                                                         |
| C01–C03, C05, C07, C09, C11, C16, C18 | Partial documentation and race tests                                                            | Need full-task review and final handoff                                     |

## 4. Next

1. B2 under DEC-2026-10-09-01: server-confirmed connected-X, fresh additional-wallet proof, denial of wallet-only sessions, session provenance and revoke invalidation, durable audit, default-off server flag.
2. Ingest the Codex reviewer report when it lands; fix findings test-first.
3. Commit/push only with explicit owner authorization.
