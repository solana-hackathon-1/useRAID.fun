# Standalone synthetic skill eligibility host

This console consumer evaluates synthetic assessment projections. It does not create or authorize an assessment, admission, Party consent, access, payment or active engagement. Canonical module links prevent a divergent implementation in the repository; an exported host copies their targets into its own source tree.

From this directory:

```sh
npm ci
npm run typecheck
npm start
```

Node >=22.12, Zod 4.6.5, bs58 6.0.0 (the shared asset contract dependency), tsx 4.23.15, TypeScript 5.9.3 and @types/node 22.20.4 are declared exactly. No environment variable, database, Next.js app singleton, provider credential or production data is required. The independent consuming check copies `host.ts`, package/lock/config, resolves the canonical `contracts/` and three `skills/` sources, installs its own node_modules and runs the commands above. Its installed temporary host is retained as verification evidence.

`host.ts` supplies explicit clock, taxonomy, policy/rubric/provenance and complete current participant snapshots. All IDs and ranks here are unmistakably synthetic. An actual host must authorize each participant and resolve current assessment history, rubric/evaluator authority and approved snapshot freshness before calling the module; these capabilities are not implemented by the fixture. See the [module contract](../../docs/raid-skill-eligibility.md).
