# Checks and affected browser coverage

Checks is dispatched manually for a candidate branch after its affected local checks and any required independent review/fix pass. Dispatch once per completed candidate; documentation edits to the PR do not require another run. Changed source, dependencies or configuration invalidate affected evidence. Match the run's source SHA before merging. Keep missing UAT, business and release evidence NOT VERIFIED.

DEC-2026-10-26-02 applies I13, R15/R16 and blueprint §§24.8/32: reduce repeated browser work without removing mandatory checks or changing application permissions, money, identity or capacity. No feature or production gate is enabled by green CI.

## Selection contract

`scripts/ci-browser-scope.py` requires Python 3, Git and a complete candidate checkout with `origin/main`. It compares every branch commit against main, accounts for both names of renames and for deletions, and selects the union of explicitly known browser consumers. Notifications-only changes select notifications. Work domain changes select work creation, work workspace and notifications, which consume those records. A direct wizard change selects creation. Explicit browser configs/specs select their own suite. Documentation and planning-contract tests need no browser execution.

Shared infrastructure, migrations, dependencies and unclassified paths select the full suite. Missing/malformed comparisons, candidates behind current main, main dispatches and empty differences also select full coverage. There is no caller-supplied selective override. New dependencies must be classified conservatively; unclassified dependencies retain full coverage.

The selector writes `browser_suites` (JSON array), `browser_required` (exact `true`/`false`) and `source_sha` to the Actions output file, and records source, comparison base, selection and omission reasons in the run summary. Without Actions environment variables it prints the same selection as JSON and changes no files. Run it from the repository root:

```sh
python3 scripts/ci-browser-scope.py
```

Every run retains planning contracts, formatting, types, lint, dependency security, all unit/real-PostgreSQL tests, schema drift, Docker build and runtime smoke. Selected browser features retain their existing development/production modes, desktop/mobile projects and write-disabled cases. The existing build and isolated Studio cleanup remain in the browser job. Staging publication is unchanged.

## Aggregate gate and recovery

`scripts/ci-gate.py` requires the workflow's `JOB_RESULTS` JSON and `GITHUB_SHA`. Every mandatory job must succeed. Selection must be present, valid and bound to that exact SHA. Every selected browser suite runs in the required browser job; that job must succeed. The only permitted skipped job is browser when a verified selection explicitly contains no suites. Failed, cancelled, missing or inconsistent evidence fails the gate. No secrets or provider credentials are needed by either helper.

## Required check on main — owner applies

`.github/rulesets/main-ci-gate.json` is a GitHub repository ruleset that requires the `ci-gate` job (which waits for every other mandatory job) on the default branch, with a pull request, no force-push or deletion, an up-to-date branch and no bypass actor. The repository does not apply it; creating a ruleset changes shared repository settings and is an owner decision. To apply it: `gh api -X POST repos/<owner>/<repo>/rulesets --input .github/rulesets/main-ci-gate.json`. Because Checks runs only by manual dispatch, dispatch it on the PR branch so the `ci-gate` result is recorded on the head commit before merging; an undispatched PR stays blocked. `tests/test_raid_ci.py` keeps the ruleset, `planning/raid-ci-matrix.json` and the workflow's `ci-gate` needs list consistent.

If main advances before merge, incorporate it without discarding existing work and verify the resulting candidate. If classification is uncertain, retain full coverage. Do not dispatch another full run for an unchanged green source without an unresolved concern. Review the run summary and logs on failures; never change the gate to reinterpret failure as success. These scripts own verification selection only, not source mutation, publication or deployment.

`tests/test_raid_ci_selection.py` is an independently runnable standard-library consumer. It builds disposable Git histories and drives the actual scripts with synthetic job results, including adverse and retry states. Run it with `python3 -m unittest discover -s tests -p 'test_raid_ci_selection.py'`; existing CI, staging and cleanup contract suites remain regression checks. Synthetic tests prove selection/gate behavior, not hosted queue latency or actual browser outcomes. No new container or listener is needed for these helper tests.

## Local-first verification and reused Checks — DEC-2026-10-27-01

`bash scripts/verify.sh fast` runs planning contracts, Prettier on files changed against `origin/main`, types, lint and the non-database unit tests (about two minutes on a developer machine). `bash scripts/verify.sh full` adds `scripts/local-ci.sh` (real PostgreSQL tests, drift, Docker build and smoke, demo/studio/live browsers) and the development-mode feature suites chosen by `scripts/ci-browser-scope.py`; set `RAID_VERIFY_FEATURE_BROWSERS=0` to skip the feature suites. Both refuse to run with uncommitted tracked changes, record per-layer seconds, and write `.git/raid-verify/<tree-sha>.json`. Hosted Checks still adds production-mode suites and remains the independent verification.

`bash scripts/verify.sh install` opts in to `.githooks/pre-push`, which blocks pushing a tree without a passing `full` receipt (documentation-only changes accept `fast`). Bypass one push with `RAID_SKIP_PREPUSH=1 git push`; the bypass is announced and does not create a receipt. Remove it with `git config --unset core.hooksPath`.

`scripts/ci-reuse-checks.py` lets the staging workflow's read-only `reuse` job look for a successful manually dispatched Checks run whose commit tree equals the tree being published. A match skips the repeated install, lint, tests and browser suites; build, runtime smoke and registry publication always run. No match, any API failure or a malformed tree reports `verified=false` and every check runs. A merge commit that adds anything beyond the candidate tree has a different tree, so it is fully rechecked. Synthetic coverage: `python3 -m unittest tests.test_raid_verify_reuse`.
