# Independent synthetic assessment host

This private console example consumes [authorized assessment preparation](../../docs/raid-skill-assessment-review.md). It demonstrates reasoned advanced review, exact rubric/submission/current records, self-review/scoped-evaluator denial, stale facts and separate capability/fraud proposals. All fixtures and local grants are invented; every result, including nested assessment data, stays PROPOSED/unpersisted/no verified rank, capacity or money effect.

Node22.12+ is required. The example pins Zod4.6.5, bs58 6.0.0 and tsx4.23.15 plus TypeScript5.9.3/Node22.20.4 types. Node crypto supplies a local alternate digest policy. No Next, Prisma, database, provider credential or hidden environment exists. The host supplies actual-clock/current-session/canonical-subject, approved historical trial/rubric, submitted evidence/current assessment/case and scoped local authority. Actual production approval, persistence/replay/notice/appeal are separate obligations.

Copy into a fresh independent directory while dereferencing its canonical source links, then install its own runtime:

```sh
cp -RL examples/skill-assessments /tmp/my-assessment-host
cd /tmp/my-assessment-host
npm ci --ignore-scripts --no-fund
npm run typecheck
npm start
```

`contracts` includes the real shared source; `skills` includes only skill/practice schemas and assessment files. `fixtures.ts` is synthetic standalone data, not executable Root state. The copied lockfile and dependencies belong to this host; root node_modules is unnecessary. The CI boundary fixture explicitly supplies its installed runtime, with separate own-install evidence proving portability.

Byte and digest adapters compare the entire normalized approved definition; local grants bind current evaluator, canonical subject, policy, submission/case and expiry. These are deterministic test substitutes, not signatures or real business authority. Sample A/B ranks, sample counts, rubric and one-day reassessment date are examples, not calibration/operating choices.

The final JSON states synthetic data, alternate ports, scoped evaluator/self-review denial, immutable versions/stale facts and reasoned reassessment without committed rank/capacity/money. Only summary booleans are logged. All CLI work ends; no server/container remains. Future durable commands must atomically recheck current versions/authority, append immutable history and original receipts, and project only committed records.
