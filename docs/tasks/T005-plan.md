# T005 — Baseline security repair packet

Issue [#47](https://github.com/solana-hackathon-1/useRAID.fun/issues/47), parent E11 #13; M0/S01 bounded prerequisite repair. Started 7 October 2026 following the owner’s “continue” after T001 independent review. Preparation owner: Codex AG09/AG03/AG10. Baseline `21f901b6815207c55fa461d7173177ede2788a2f`; branch `codex/t005-baseline-security`.

## Outcome and dependency boundary

Reduce the five unallowlisted dependency findings through compatible patched releases or a verified dependency substitution, while preserving the existing gate and supported web/worker behavior. [T001 review](T001-review.md) accepted the source inventory and non-code boundary at `acc025085dda867bdd21c570a6825fefe8bc5088`; T001 C22 still fails. The owner’s continuation authorizes this bounded prerequisite repair preparation. The T001/T005 graph and issue completion do not change: this repair can supply missing evidence but cannot self-approve either task, hide C22 or make an unready deployment Ready.

T005 has a wider assignment: Actions startup history, Cloudflare failure, environment/O18 options and staging path. Inspect available history/configuration and document evidence/options; select no commercial hosting provider or enable any release without an accepted owner decision. This bounded repair is not the whole T005 completion packet.

## Contract mapping

Authority: [blueprint](../../RAID_AGENT_BLUEPRINT.md) 00–04/13, 07/10/16, 24, 27–32, AG09/AG03/AG08/AG10 in 33, M0/gates in 34, AC67/68/73/74/75 in 35, 39/40; [task contracts](../raid-agent-task-contracts.md), [reuse contract](../raid-module-reuse.md). IDs: D01/D12, I05/I06/I09–I13, R15/R16. LOCKED/DEFAULT remain intact; O18 hosting and all related live gates remain OPEN. Existing SDK coupling is not declared compliant merely because a dependency is patched.

Affected files: `package.json`, `package-lock.json`, `tests/dependency-security.test.ts`; same-change task/verification documentation and all 27 T005 criterion records. Inspect `scripts/audit-check.ts`, `audit-allowlist.json`, `.github/workflows/checks.yml`, actual Next installation/upgrade guides, SDK consumers, migrations, flags and operations docs. No business command, permission, schema, migration or policy transition is assigned. Existing User/wallet/campaign/ledger/transfer/job/FinancialTx identities, pending signatures, semantic IDs, asset/network/provider bindings and claims remain authoritative; a JSON-RPC request ID is transport correlation, not a payout key.

Allowed actors/actions: developer reads source and runs local/CI synthetic fixtures without production/customer data or signers. Negative boundary: no live transfers, provider switching, secret export, scoped-access grant, deployment or weakening audit/CI. Any transitive major override requires documented consumed API compatibility and negative tests; do not override stream-json to incompatible ESM paths or silently downgrade Solana/Next.

## Acceptance before implementation

1. Record original five advisory IDs, package paths, existing gate failure, registry versions and primary upstream evidence. Findings with no safe patched path remain blockers rather than new allowlist entries.
2. Write meaningful failing behavior tests before dependency edits: invalid indexed-source-map offsets must be rejected without excessive work; patched native SVG dependency must be present and still rasterize a valid fixture; streamed JSON must preserve own `__proto__` data without inherited permissions. Use bounded fixtures, not destructive memory exhaustion.
3. If substituting Jayson’s dependency major, verify the actual Web3.js HTTP/browser client API: exact endpoint/JSON-RPC params/finality, response/error behavior and one dispatch per request. State TCP/server framing limits and node/browser host requirements; no generic provider switch or live compatibility claim.
4. Record genuine RED at unchanged dependency baseline, minimal GREEN for implemented patch behavior and regression checks. Discover new tests through existing Vitest `tests/**/*.test.ts` and unchanged CI test job.
5. Run existing audit evaluator regressions, typecheck/lint/build, repository planning/document checks and relevant unit suites. CI owns real DB/container/browser checks if the local Docker daemon remains unavailable. Record exact candidate head/checkout/job URLs and actual counts/skips; unfinished jobs remain unverified.
6. Include all numbered T005 records with independent review pending; retain failed security/hosting evidence and required gates. Completion validator must reject incomplete evidence. Existing T001 issue/PR remain documentation-only; deliver repair on a separate draft PR stacked on its inventory branch.

Rollback: revert dependency commits and install from the old lockfile only as an explicitly vulnerable rollback; no database or financial rollback occurs. Existing signed/submitted operations remain pinned and reconcile through existing paths. No production deployment or on-chain action is performed.
