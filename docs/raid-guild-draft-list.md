# Private owner draft index

T009D1, R01–R04/R10/R15/R16, I06/I07/I10/I13 and blueprint06/07/10/13/23–30/33/34M1/35AC07,73–75. Built on [private storage](raid-guild-drafts.md), [HTTP](raid-guild-draft-http.md) and [owner form](raid-guild-draft-form.md). Full T009/project-Founder/token/grants/public/media/ownership/O11/G10/independent UAT remain NOT VERIFIED. This lists private unverified preparation, not an activated Guild or permission record.

## Module and host

`listGuildDrafts(tx,actor,input)` extends the replaceable PostgreSQL READ COMMITTED storage interface without adding tables or migrations. The host derives the current session/canonical account from its server cookie; existing GuildDraftActor, User/Session tables, sanitized parameterized query port, rollback/whole-transaction retry and UTC database clock requirements still apply. No root auth/Prisma/provider dependency enters the module. The independent pg host consumes the same method with its own declared schema/dependencies.

Input is strict `{cursor:null|uuid,pageSize:integer1..20}`; cursor never supplies an account ID. Current own actor/session/restriction is checked before any read, held through commit and rechecked after loading the bounded page. Unknown and foreign valid cursors both yield NOT_FOUND. Invalid size/UUID/extra authority input yields INVALID_INPUT. Suspended/expired/foreign sessions retain the existing denials. Reads work independently of the host's new-write switch and mutate no receipt/audit/outbox/history or business row.

Output is strict `{version:v1,drafts:[SavedGuildDraft],nextCursor:null|lastDisplayedUUID}`. Each DTO is the same current private, unverified snapshot with no cookie, account/receipt secret, private configuration or authority grant. At most20 records are loaded; SQL fetches one additional row only to decide continuation. Results are newest first by immutable first-version creation timestamp then UUID. Updating an older record does not move it across a cursor, and timestamp precision remains in PostgreSQL rather than a rounded client cursor. Version/current-owner joins and typed response binding protect projection provenance.

## Root private page

/creator/guild-drafts uses the real current cookie/account, fixed20 pageSize and optional strictly validated cursor. It shows own current names/descriptions/revisions and edit links, an honest empty/unavailable state and More private drafts when needed. Anonymous users see Sign in; foreign/missing cursor failures reveal no records. Generic dynamic metadata contains no private title/description. Account and new/edit pages link to the index, so acknowledged saved URLs remain findable after refreshing the creation page. Saving stays defaultoff/non-demo as before; existing reads remain available.

This recovers discoverability of persisted acknowledged records. An unknown pending request key/body lost when closing a page remains a separate reconciliation contract; no across-refresh replay guarantee is invented. Names/descriptions render as escaped text; no URL import, public indexing, membership/Founder badge, token linkage, capacity or money effect.

## Consumption and verification

[The independent example](../examples/guild-drafts/README.md) refreshes only canonical module/contracts files and reuses its own installed pg/zod/bs58/tsx/React dependencies. After real storage/portable HTTP writes it consumes pageSize1/nextCursor, checks current own snapshots, no foreign bytes or receipt mutation, and preserves original replay/privacy/retry contracts. No root app/SDK/credentials are used.

Five database behaviors were defined and failed against an executable stub before implementation: empty/no writes, current-version pagination/immutable order, concurrent newer creations/owner-bound cursors, malformed/unbounded/forged scope, current session/restriction. GREEN26 includes the21 existing protected storage cases. Missing-index desktop/mobile RED precedes the page; the same browser suite then checks find-after-refresh,20/2 pagination/edit links and anonymous/other-account confidentiality. Discovery RED8-vs10 precedes updating the exact ten-case contract; the suite still runs before staging publication alongside eight orientation cases. Actual source/hash/check/reuse/preview/build and resource evidence is under T009-list/CURRENT.md; SELF-EVALUATED only.

Use only declared synthetic fixtures and owned available dev server/ports; retain artifacts then stop owned DB/browser/Next on success/failure. A development preview and production build are distinct, and neither proves representative UAT or healthy public ingress. HTTP/store/form rollback preserves acknowledged private versions/receipts/audit. Production retention/recovery, verified relationships and ownership-transfer authority remain unfinished independent contracts.
