# Current checkpoint

- 2026-10-27 ~12:40 NPT / 07:00 UTC, Claude Sonnet 5.5. One active writer, main checkout on `main` (2b50e0c). Owner direction: open PRs only — **do not merge, do not start independent review, do not dispatch Checks** until the owner allows; keep developing from the project board. Old checkpoint backed up outside repo (scratchpad `CURRENT.before-pr-stretch-20261027.md`).
- Merged earlier (see backup): #250, #252, #254, #255. All work below is OPEN PRs, none merged, no review, Checks NOT dispatched.
- Open PRs (each: real-PG full suite green, `verify fast` pass, consuming `examples/raid-terms` host passes; `verify full` NOT RUN because unrelated container holds port 55432):
  - #256 `claude/t025-amendment-followups` closes #244 items 1–3; required `AmendmentHost.authorizeProposer({accountId})`; migration 202610270002. Full suite predates that contract tweak (affected suites rerun).
  - #257 `claude/t023-submission-followups` (#240): JSON-shape CHECKs, migration 202610270003.
  - #258 `claude/t021-application-followups` (#239 items 1–6; item 7 deferred): `AcceptanceHost.authorizeOfferIssuer({accountId})`, `OFFER_EXPIRED`, offers revoked on terms edit, index, migration 202610270004.
  - #259 `claude/t024-closure-followups` (#241 residuals; item 6 left as restricted-claims policy): migration 202610270005, replay re-authorization.
  - #260 `claude/t097-public-raid-feed`: public `/raids` + `GET /api/v1/work/feed`, flag `WORK_FEED_READS_ENABLED`; no schema change; no detail page yet.
- Branches #256–#259 each add a symlink + list line in `examples/raid-terms` and the same `scripts/verify.sh` symlink fix: expect trivial merge conflicts in `host.ts`/README.
- Risky-boundary reviews required (NOT STARTED, owner has not allowed): #256, #257, #258, #259 (migrations/authority/capacity). #260 is non-risky (CI + self-check).
- Owned resources: all task Postgres containers and dev server (port 3097) stopped/removed. Unrelated containers (`raid-deps-upgrade-test-20261024` on 55432 and old previews) preserved. Dirty but preserved: untracked `WARP.md`; this file.
- NOT VERIFIED: independent review, closure packets/validator, UAT (U001–U016), business/release evidence, `verify full`, Checks on every PR.
- Board note: project board statuses are stale (most tasks "Blocked"); T016–T025, T017, T018, T042, T029 are built. Ruleset requiring `ci-gate` on main is still an owner decision.
- Next, in order: (1) continue board-driven slices after #260: Raid detail + apply (needs a host `assess`; acceptance is not offered in the browser), T015 homepage/directory placement; (2) when the owner allows, review in order #256 → #259 → #258 → #257, one fix pass each; (3) after review, dispatch Checks once per PR and merge only on owner say-so.
