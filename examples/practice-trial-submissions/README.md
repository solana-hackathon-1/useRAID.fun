# Independent private practice-submission PostgreSQL host

Synthetic PostgreSQL16 CLI consumer for durable private first submissions. Node≥22.12 and locked pg8.23.1/Zod4.6.5/bs58 6.0.0/tsx4.23.15; TypeScript5.9.3 and Node types22.20.4 are explicit. Canonical relative source/SQL links are dereferenced into a separate source tree with its own dependencies:

```sh
consumer_dir=$(mktemp -d /tmp/raid-practice-submission-consumer-XXXXXX)
cp -RL examples/practice-trial-submissions/. "$consumer_dir/"
cd "$consumer_dir"
npm ci --ignore-scripts
npm run typecheck
export NODE_ENV=test
export DATABASE_URL='postgresql://postgres:synthetic-only@127.0.0.1:YOUR_OWN_PORT/useraid_practice_submission_host_test'
npm run migrate
npm start
```

Provision a fresh dedicated loopback PostgreSQL16 database first. URL validation rejects other names, remote hosts and production mode. One-time migrate applies minimal User/Session, actual immutable canonical HUMAN mapping plus its composite identity key, exact receipt/catalog/practice/start SQL and additive30 private submission SQL. No Root installation/Prisma, real credentials, provider or live authority seed is required. Explicit synthetic fixture provisioning creates an actual HUMAN; start/submit never autoprovision identity. Migration requires a fresh empty fixture and does not authorize destructive cleanup.

The host owns real READ COMMITTED BEGIN/COMMIT/ROLLBACK/whole retries and asserts actual transaction-local5s statement/2s lock/5s idle bounds; these are synthetic host technical settings. It publishes an invented safe unpaid definition, starts two authorized ordinary wallet/HUMAN attempts under the actual family limit, submits exact code text and declarations, rejects changed original-key content/different-key overwrite, completes the second accepted start after retirement, reads private history and preserves exact original replay with writes disabled. Publisher policy replacement/revocation never grants private access or removes ordinary learner authority; actual learner-session deletion denies both start/submission replay. Expected summary booleans include immutablePrivateSubmission, exactCodeWhitespace, originalConsentAfterRetirement, ownershipRemainsUnconfirmed, originalSubmissionAfterDisablement and existing synthetic/canonical/history/policy/no-rank checks.

Responses/disclosures remain private untrusted plain text and must not be rendered as HTML, executed, fetched or logged as content. Authenticated submission does not prove originality: ownership stays UNCONFIRMED, tool/AI declarations remain claimant evidence and no assessment/rank/grant/capacity/money follows. Current trusted future reviewers must apply the exact original policy; declared deviations are not automatically approved. No public MediaAsset, upload/provider, execution runner, hard time cutoff, scoped evaluator/accommodation authority, HTTP/UI or production rollout is supplied. Full T013/independent review/UAT/business/release remain NOT VERIFIED.

Pools close in finally on every outcome. The fixture owner stops only owned PostgreSQL resources, retaining evidence/source and unrelated services/images/volumes. Preserve immutable original consent/response/receipt/private audit and actual current owner/SQL locks when substituting a host. See the same-change storage contract for errors, privacy, transaction ownership, schema/retention and recovery limits.
