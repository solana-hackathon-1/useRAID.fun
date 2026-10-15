# Independently installed actual ownership-finding host

This synthetic minimal PostgreSQL host consumes the published ownership-finding command and scoped historical read. It wires actual original private submission/definition/rubric, actual current reviewer appointment/own Session, actual current canonical approved policy, private case/policy audits, immutable finding/correction/CAS/history and original retry after policy withdrawal/writeoff. It verifies current case denial after revocation and that the original submission remains UNCONFIRMED. Findings do not verify rank, grant access, decide fraud guilt or create capacity/money/provider effects.

No Next.js, Prisma, Root auth global, Root node_modules or real operating approval is used. All account/session/HUMAN/receipt/catalog/practice/assignment/policy/ownership SQL/runtime/types dependencies are declared. READ_COMMITTED transaction/rollback/whole retries and actual local5s statement/2s lock/5s idle bounds are explicit. Current scoped host predicates receive actual saved identities/source. Snapshots are delivered only after COMMIT, never as authorization tokens. Technical limits and synthetic guidance are not production calibration or staff approval. Canonical symlinks retain one source and must be dereferenced for standalone copying.

Use Node>=22.12 and a fresh dedicated PostgreSQL16 database named useraid_practice_trial_ownership_host_test; localhost/loopback only and NODE_ENV=production is rejected. Never use live records or real approvals.

```sh
cp -RL examples/practice-trial-ownership /tmp/raid-ownership-example
cd /tmp/raid-ownership-example
npm ci
npm run typecheck
DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:5432/useraid_practice_trial_ownership_host_test npm run migrate
DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:5432/useraid_practice_trial_ownership_host_test npm start
```

Credentials/port are synthetic examples; use only a dedicated owned fixture. Install dependencies independently. Replace pg or scoped policy predicates while preserving all source/current-authority/audit/transaction/failure/clock contracts. No actual policy content/evaluator/finding is seeded in Root. O09/O11/staffed operating approval, actual rank assessment/reassessment/projections/APIUI and independent/UAT/business/release acceptance remain separate. See [module contracts](../../docs/raid-practice-trial-ownership.md) for API/events/errors/migration/recovery and [task evidence](../../planning/task-evidence/T013-trial-ownership/) for actual results.
