# Independent synthetic practice-trial host

This private console example consumes the canonical v1 [practice contract](../../docs/raid-practice-trials.md). It demonstrates safe approved public/synthetic definitions, canonical own attempt preparation, stale/foreign/changed-definition rejection and exact approved accommodations with byte and digest approval adapters. Its fixtures are invented; it grants no assessment/rank/access/capacity/payment authority.

Node22.12+ is required. Runtime dependencies are pinned Zod4.6.5, bs58 6.0.0 and tsx4.23.15; strict TypeScript5.9.3 and Node22.20.4 types are explicit development dependencies. There is no Next, Prisma, DB, provider token or environment configuration. The host supplies time, canonical participant, published catalog, immutable trial definition and current history, plus full-payload synchronous approval functions. A production host must obtain these from its real authority and implement the atomic durable start boundary documented in the contract.

Copy the example while dereferencing its canonical source links into an independent directory, then install its own runtime:

```sh
cp -RL examples/practice-trials /tmp/my-practice-host
cd /tmp/my-practice-host
npm ci --ignore-scripts --no-fund
npm run typecheck
npm start
```

Use a fresh destination. `contracts` links to the canonical shared contract directory; `skills` links only to skill contracts and the two practice module files. Copying with `-L` includes the real source so no RAID app singleton or root node_modules is needed. The lockfile belongs to this example; installing packages inside the source checkout is unnecessary. The CI boundary fixture explicitly supplies its CI runtime; separate own-install evidence verifies portability.

The printed JSON identifies synthetic fixtures, alternate approval ports, immutable content, canonical subject, stale-history denial, approved accommodation and no rank/capacity/financial effect. Repeated preparation produces no receipt or attempt consumption; the future host must atomically store/recheck current facts. Sample numerical limits and A target are examples, not adopted production thresholds. No server/container stays running and no secret is printed.
