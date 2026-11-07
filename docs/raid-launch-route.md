# Launch route adapter (Meteora Dynamic Bonding Curve to DAMM v2, devnet)

[Launchpad](../RAID_AGENT_BLUEPRINT.md#05-launchpad) · [Token economy](../RAID_AGENT_BLUEPRINT.md#22-token-economy) · [Module reuse](raid-module-reuse.md) · Decision DEC-2026-11-07-04 (O01 route)

**Status: delivered for devnet as a typed R15 adapter with a verified consuming example. NOT a launch feature.** O02 (launch economics) and O08 (fees) stay OPEN, so the route returns a controlled `NOT_CONFIGURED` state until a host supplies economics from a recorded decision. No mainnet use, no transaction is signed or sent, T028 and the mainnet release gate (05.6) are NOT VERIFIED. The disabled Pump code (`src/lib/pump-launch.ts`) is untouched: existing intents stay pinned to their protocol, Pump retirement is a later reviewed change.

## Purpose and non-goals

Satisfies R15 (stable replaceable contract) and R16 (documented host dependencies and a verified consuming example). Gives the domain one replaceable interface for launching a Guild token, matching blueprint 05.4: `validateLaunch`, `quoteLaunch`, `prepareLaunch`, `verifyLaunch`, `getMarketStatus`, `reconcileLaunch`, plus `capabilities`. The first implementation targets Meteora's Dynamic Bonding Curve (no custom RAID curve) that graduates to DAMM v2 with a USDC quote (devnet USDC, the same mint as `USDC_MINTS.devnet` in `src/lib/usdc.ts`).

Non-goals: choosing supply, allocation, curve, fees, vesting or migration thresholds (O02, O08); a Meteora SDK or RPC binding; wallet signing; persistence of launch intents (the existing `TokenLaunch` table is unchanged); UI; mainnet; Guild activation after launch (05.2 step 9); retiring Pump.

## Dependency and host contract

- Entry point `src/launch-route/index.ts`. Copy `src/launch-route` and `src/contracts` as siblings. Dependencies: Zod and bs58 through `src/contracts/assets.ts`, and `node:crypto` for SHA-256. No Next.js, Prisma, Solana or Meteora SDK, environment variable or secret (enforced by `tests/launch-route-boundary.test.ts`).
- The host supplies `client` (a `MeteoraDbcClient`: `quote`, `buildUnsignedLaunch`, `getTransactionStatus`, `getPoolState`), a `now()` clock and, once decided, `economics`. The client builds **unsigned** transactions; no key ever reaches this module. The host owns signing by the founder's authorized wallet, submission, persistence and authorization.
- A real client binding (Meteora SDK `@meteora-ag/dynamic-bonding-curve-sdk`, documented as 2.0.0 or later) is host work and is not shipped, so no dependency was added.

## Public interface

| Export                                                              | Behavior                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createMeteoraDbcLaunchRoute({ network, client, now, economics? })` | Returns a frozen `LaunchRoute`. Throws `LaunchRouteError('NETWORK_REFUSED')` unless `network === 'DEVNET'` (mainnet, mainnet genesis, testnet or missing are all refused).                                                                                                                                  |
| `capabilities()`                                                    | Protocol, program id, network, quote mint, graduation target, `configured`, `openDecisions` (`O02`,`O08` while unconfigured) and the immutable-metadata finding below.                                                                                                                                      |
| `validateLaunch(request)`                                           | Checks founder wallet, intent id, metadata (name, symbol, `https://` or `ipfs://` URI) and the economics shape. Returns a SHA-256 `parameterHash` over canonical (sorted-key) JSON of protocol, program, network, quote mint, graduation, fee claimer, founder, metadata and the opaque `configParameters`. |
| `quoteLaunch(request)`                                              | Provider quote with `quoteId`, `expiresAt`, provider amounts as decimal strings and the `parameterHash`. Amounts are never summed or priced.                                                                                                                                                                |
| `prepareLaunch(request, quote)`                                     | Refuses an expired quote (`QUOTE_EXPIRED`, at or after `expiresAt`) or a quote for different parameters (`INCONSISTENT_STATE`), then returns `{ signed: false, intent, transactions }` where `intent` is the pinned `PinnedLaunchIntent`.                                                                   |
| `verifyLaunch(intent, signatures)`                                  | Maps observations to launch states: `SUBMITTED`, `CONFIRMED_PENDING_FINALITY`, `ACTION_REQUIRED` (fewer signatures than prepared transactions), `LIVE` (all finalized and the pool matches program, mint, quote mint and fee claimer). Reports authorities and signatures in `facts`.                       |
| `getMarketStatus(intent)`                                           | Provider-specific `phase` from Meteora `MigrationProgress` (`PRE_BONDING_CURVE`, `POST_BONDING_CURVE`, `LOCKED_VESTING`, `CREATED_POOL`, or `NOT_FOUND`), raw `quoteReserve` and `migrationQuoteThreshold`, and `graduated`. No percentage.                                                                 |
| `reconcileLaunch(intent, signatures)`                               | `verifyLaunch` plus `getMarketStatus`; repeatable and side-effect free.                                                                                                                                                                                                                                     |
| `LaunchRouteError`, `ProviderFault`, `LAUNCH_ROUTE_ERROR_CODES`     | Typed errors. A client may throw `ProviderFault` with `INSUFFICIENT_FUNDS`, `UNSUPPORTED_PARAMETERS`, `SIGNATURE_REJECTED` or `PROVIDER_UNAVAILABLE`; any other error becomes `PROVIDER_UNAVAILABLE`.                                                                                                       |

Operations return `{ ok: true, value } | { ok: false, error: { code, detail? } }` and do not throw for expected failures. Error codes: `NOT_CONFIGURED`, `NETWORK_REFUSED`, `PROTOCOL_MISMATCH`, `UNSUPPORTED_PARAMETERS`, `QUOTE_EXPIRED`, `INSUFFICIENT_FUNDS`, `SIGNATURE_REJECTED`, `TRANSACTION_UNKNOWN`, `TRANSACTION_FAILED`, `PARTIAL_COMPLETION`, `PROVIDER_UNAVAILABLE`, `INCONSISTENT_STATE`. Messages and details are fixed tokens, never input or provider text.

## Entity and state ownership

This module stores nothing. A `PinnedLaunchIntent` (protocol `METEORA_DBC`, program id, `DEVNET`, intent id, parameter hash, quote mint, fee claimer, founder wallet, mint, pool, quote id, transaction count) is returned for the host to persist with its launch record. States follow blueprint 05.3; the adapter establishes `SUBMITTED`, `CONFIRMED_PENDING_FINALITY`, `ACTION_REQUIRED` and `LIVE`, and reports `FAILED`-class outcomes as typed errors. `DRAFT`, `READY_FOR_SIGNATURE` and `CANCELLED` are host states. Market phases are separate from launch states (05.3): a Guild is "graduated" only when `MigrationProgress` is `CreatedPool` and a DAMM v2 pool address is reported; reaching the quote threshold is not graduation.

## Permissions and trust boundary

No actor-bearing command and no grant. Authority to start a launch, the founder's identity and wallet signature, and enabling the route belong to the host (existing `LAUNCH_ENABLED` gating stays in the application; this module is not wired to it). `economics.decisionRef` and `feeClaimer` are host assertions this module cannot authenticate. Pinning: `verifyLaunch`, `getMarketStatus` and `reconcileLaunch` return `PROTOCOL_MISMATCH` for an intent pinned to another protocol, program, network or quote mint, and `INCONSISTENT_STATE` when the observed pool has a different mint, program, quote mint or fee claimer. The route never switches protocol, mint or fee recipient silently.

## Configuration names

None read from the environment. Host-supplied structure: `network` (`DEVNET` only), `client`, `now`, `economics` = `{ decisionRef, feeClaimer, graduation: 'DAMM_V2', configParameters }`. `configParameters` is opaque canonical JSON passed to the client and hashed; it must not name a quote mint other than devnet USDC. No default is shipped: with no `economics` the route is `NOT_CONFIGURED`. No secrets.

## Errors and idempotency

All operations are deterministic over the client's observations; repeating `verifyLaunch`, `getMarketStatus` or `reconcileLaunch` gives the same result for the same observations. `prepareLaunch` calls the builder once per call and does not deduplicate: the host must persist the first `PinnedLaunchIntent` per `intentId` and reuse it (command-receipt style idempotency is the host's, as in `src/command-receipts`). Reusing a quote after expiry or for changed parameters is refused.

## Substitution and versioning

Consumers depend only on the `LaunchRoute` interface and result types (contract version v1); `examples/launch-route` runs the same consumer against the Meteora route and an independent replay route with identical results. Replacing the provider means a new implementation of the interface; an existing intent stays pinned to its original protocol/program/mint/fee claimer and the new route rejects it with `PROTOCOL_MISMATCH` rather than reinterpreting it. In-flight operations must drain on the route they started on. A contract change needs a reviewed version bump and consumer updates. Rollback: remove the route registration in the host; nothing here is persisted.

## Observability

No logging or metrics are emitted. Hosts should record error codes and `detail` tokens, `parameterHash`, intent id, signature list, launch state and market phase transitions, and count `INCONSISTENT_STATE` and `PROTOCOL_MISMATCH`. Case owner and alerting are not established (G10), NOT VERIFIED.

## Failure and recovery runbook

- `NOT_CONFIGURED`: expected until O02 and O08 are decided and a host passes `economics`. Show a "launch not configured" state; do not default any value.
- `NETWORK_REFUSED` at startup: the deployment asked for a non-devnet network. Fix configuration; there is no override.
- `QUOTE_EXPIRED`: request a new quote, then prepare again. Do not reuse transactions built from the old quote.
- `TRANSACTION_UNKNOWN` / `SUBMITTED`: do not mark failed or complete; poll again. Unknown is not zero.
- `PARTIAL_COMPLETION` / `ACTION_REQUIRED`: resume the exact pinned intent for the missing step; do not create a second mint. Reconcile before retry.
- `INCONSISTENT_STATE`: treat as an incident. Compare the observed pool with the pinned intent; never rewrite the intent to match.
- `PROVIDER_UNAVAILABLE`: retry later; no state was changed by this module.

## Limitations

- **Immutable token metadata (Meteora documentation check).** Source: <https://docs.meteora.ag/developer-guides/dbc/program/accounts>. The pool config field `token_update_authority` takes `TokenAuthorityOption`: `0` creator update authority, `1` immutable, `2` partner update authority, `3` creator update and mint authority, `4` partner update and mint authority (values 3 and 4 only for transfer-hook configs, per <https://docs.meteora.ag/core-products/dbc/launch-configurations.md>). So an "immutable" update authority option is documented. It has **not been exercised on devnet** by RAID, the documentation read does not list the token name/symbol/URI parameter names, and the Metaplex metadata behavior after launch is not confirmed. Therefore nothing relies on it: `capabilities().immutableMetadata` is `{ documented: true, relied: false, verifiedOnChain: false }`, the adapter does not require `IMMUTABLE`, and `verifyLaunch` reports the observed authority. Relying on it needs a devnet test and an owner decision.
- **USDC as quote mint is not explicitly documented.** Meteora states SPL Token quote mints are permissionless (<https://docs.meteora.ag/core-products/dbc/launch-configurations.md>); USDC appears only in the mainnet migration keeper table. Devnet USDC quote acceptance is NOT VERIFIED until a devnet run.
- **Program id** `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` is documented for Mainnet Beta and Devnet (<https://docs.meteora.ag/developer-guides/dbc>); no on-chain check was run here.
- The full `ConfigParameters` field list and the SDK's current version were not read from the documentation; `configParameters` is therefore opaque and the real binding is unwritten and NOT VERIFIED.
- `isMigrated` is not used; graduation is derived from `migration_progress` (`CreatedPool`) plus a reported DAMM v2 pool address.
- The Meteora client port, wallet signing UX, persistence, Guild activation and any end-to-end devnet run are NOT DELIVERED and NOT VERIFIED. T028 and mainnet gate 05.6 stay NOT VERIFIED.
- Metadata name and symbol are bounded to 200 characters here; provider limits are enforced by the provider and surface as `UNSUPPORTED_PARAMETERS`.

## Run the standalone consuming host

```bash
cp -RL examples/launch-route /tmp/launch-route-host   # dereferences the two symlinks
cd /tmp/launch-route-host
npm install --no-audit --no-fund
npx tsx host.ts
```

The host needs no database, network or environment variable and prints one JSON object whose values are all `true`.
