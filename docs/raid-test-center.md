# Local implementation test center

Open `/test-center` in the Studio sandbox or a demo preview. The center covers the inspected local
T001–T006, T019 and T029 foundation plus the existing legacy campaign screens. It is an entry point
for testing, not an issue acceptance dashboard; the cards are a dated source inventory, not live GitHub status.

## Try the UI

For the existing local Studio setup, start the local database and run `npm run studio:preview`,
then open `http://localhost:3007/test-center`. That existing launcher prepares the dedicated
`useraid_studio_test` database in your Compose PostgreSQL. It must not be pointed at a shared or live database.
The separately isolated preview created for this task uses its own tmpfs container instead; exact local
resource details and commands are in [the task record](tasks/2026-10-10-test-center.md).

1. Click **Enter test Creator Studio** to create a fixture session and test balance through the existing sandbox API.
2. Choose **Create Raid → X Campaign**; preview `https://x.com/project/status/123456789123456789`.
3. Set reward budget to 2.5 test USDC; expect 2,500 target impressions. Save a draft, then fund and launch.
4. Use the campaign's fixture contributor/review controls; inspect allocation, report and public Raid.
5. Open test Admin and confirm the test payment; return to Studio and inspect the paid state.

Fixture accounts, X posts and USDC are explicitly simulated. This legacy flow does not verify new
Guilds, engagement reservations, wallet signatures, provider OAuth or real escrow/chain finality.
T006 additional-wallet routes/revoke/audit/UI remain gated; the center never changes `WALLET_LINKS_ENABLED`.

## Public component contract

`TestCenter({ sandbox: boolean, children?: ReactNode })` is a v1 presentation component at
[the canonical source](../src/components/test-center.tsx). It imports React and the actual T002/T029
pure helper contracts; no credentials, database, Next routing, HTTP client or hidden application singleton.
The [independent consuming host](../examples/test-center/README.md) declares React, React DOM, Zod,
base58 and TypeScript execution dependencies. The browser host supplies CSS and local URL routing.

Dependency direction: host page → TestCenter → bounded amount/shared-state helpers.
The host separately supplies optional sandbox actions as children. The `sandbox` prop displays available
test links but grants no permission. Host route and action handlers own authentication/authorization.
Do not compose fixture actions into a production host. No records are mutated by filters or explorers.

| Interaction        | Result                                                            | Limits                                                                                    |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Coverage filter    | Browser, backend or all cards                                     | Describes test access; no pass/fail or release status inferred                            |
| Exact amount form  | Unsigned 64-bit base units, canonical display, proportional split | Example decimals, not verified mint metadata; no balances or transfer                     |
| Bad amount/weights | Typed error and prior result cleared; form draft retained         | No rounding, overflow, or zero-sum split accepted; up to 16 weights                       |
| Capacity selector  | Actual `consumesCapacity` outcome                                 | State vocabulary only; cannot validate a transition or prove DB uniqueness                |
| Sandbox children   | Existing host API behavior                                        | API independently checks sandbox/actor/origin; fixture identity is not cryptographic auth |

The amount form accepts 0/6/9 example precision; errors include `EXCESS_PRECISION`, `AMOUNT_OVERFLOW`,
`INVALID_AMOUNT` and `INVALID_ALLOCATION`. Largest-remainder splits assign ties to the first index.
Neither sample weights nor precision selects a production payout or asset policy.

## Accessibility, verification and recovery

Semantic sections/headings, labeled inputs, pressed-state filter buttons, visible focus and live
status/alert regions support keyboard and screen readers. CSS stacks panels on mobile and wraps large integers.
Errors retain inputs and clear outdated output; calculations make no HTTP request or business write.
Browser checks cover exact precision rejection/recovery, bound overflow, remainder conservation,
capacity closure, issue filtering, mobile reflow and entering the existing fixture Studio.

Run `npx playwright test tests/browser-studio/test-center.spec.ts --config=playwright.studio.config.ts`
with the appropriate dedicated preview. Broader Studio regressions are recorded in the task evidence.
Database races, restore and cryptographic/provider proofs require their independent tests; this UI cannot substitute for them.

No migration, backfill, audit event or new API endpoint is introduced. To remove the center, remove
the page/component/CSS and the preview navigation links. Existing records and sandbox behavior remain governed by their hosts.
The new route invokes Next's not-found boundary outside demo mode or the server-validated Studio sandbox;
it renders no test controls or issue cards and is marked noindex. Next can return HTTP 200 for a streamed
not-found response; the existing sandbox API separately returns HTTP 404 when disabled.
No credentials or private backend observations are serialized by this component. Local errors are typed helper failures.

Maps to R15/R16, I03/I06/I10/I12/I13 and AC70/AC74; blueprint §§13, 16.2–16.3, 23, 24.7, 28, 33.4, 34.1, 35, 39–40.
Independent acceptance, representative UAT and hosted CI are still unverified.
