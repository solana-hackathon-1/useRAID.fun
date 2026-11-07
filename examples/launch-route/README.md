# Launch route example

Standalone host for `src/launch-route` (`launch-route` and `contracts` are links to the source). It drives the Meteora Dynamic Bonding Curve adapter with an in-memory client and synthetic addresses, and checks: unconfigured by default (O02/O08 OPEN), mainnet refused at construction, an intent pinned to protocol/program/network/mint, `LIVE` only when finalized and matching, graduation only when the DAMM v2 pool is created, and that a different route implementing the same `LaunchRoute` interface gives the consumer the same results. It signs and sends nothing, reads no environment, network or credential, and uses no Meteora SDK.

```sh
npm install && npm start
```

See [launch route contract](../../docs/raid-launch-route.md) and [module reuse](../../docs/raid-module-reuse.md).
