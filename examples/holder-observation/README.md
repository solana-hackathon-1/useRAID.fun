# Independent holder observation host

See [the module and host contract](../../docs/raid-holder-observation.md). Node22.12+, exact zod4.6.5/bs586.0.0/tsx4.23.15 and canonical shared contracts are required. Use a fresh available destination; canonical links are dereferenced into the copied host, which installs its own node_modules.

```sh
cp -RL examples/holder-observation /tmp/raid-holder-observation-host
cd /tmp/raid-holder-observation-host
npm ci --ignore-scripts --no-audit --no-fund
npm start
```

No Next/Prisma/database/auth singleton, environment variable, server, wallet key, actual recognized Guild or live RPC is used. Two explicit synthetic adapters return complete exact-asset token-account observations, including a serialized payload parsed by the canonical schema. The host preserves large balances/slot strings, aggregates both current wallets, reports unavailable/stale as null eligibility and proves holder eligibility does not grant existing private profile edit permission. No public association/notification subscription, permission, work/claim mutation or capacity effect occurs.

Policy/relationship/wallet/provider facts are fabricated test fixtures; threshold1 demonstrates the blueprint positive-balance default, not approval of a real dust/finality/freshness/provider policy. The host owner must authenticate/recheck actual context and current recognition, enforce finite reads/rate limits, validate network/program/ownership/supported extensions/finality and collect complete observations before live use. Real persistence/private downloads/history/UAT/gates remain NOT VERIFIED. Each CLI exits without an owned server/pool/container; retain evidence and preserve unrelated resources. No package publication or provider activation.
