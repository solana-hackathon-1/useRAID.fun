# Private Raider preferences storage

## Purpose and non-goals

T008B records self-described interests, timezone, experience and orientation acknowledgment privately. R04/R12/R13/R15/R16, I05/I06/I07/I10/I13, AC03/AC06 partial, AC69/AC73–AC75; blueprint07–10/13/16.13/24–30/33.5/34M1. Registration/preferences confer no assessed rank, reputation, active engagement, code grant or payout authority. Actual starter tasks, assessments, verified payout and paid commitments remain separate commands. Full T008, independent review/UAT and live operating gates are NOT VERIFIED.

## Public interface

Import `src/raider-onboarding/storage`: `saveRaiderOrientation(tx, command, host, options?)`, `readRaiderOrientation(tx, actor)`, `SaveRaiderOrientationInputSchema`, `SavedOrientationSchema`, `OrientationStorageError` and their exported types. The pure entry point also exports `normalizeRaiderOrientationPreferences`, reusing the preparation schema without mutable catalog checks.

A save has trusted `OrientationActor` (`accountId`, `actorAccountId`, server-derived SHA256 `sessionHash`), opaque `idempotencyKey`/`requestId`, and strict input `{ expectedRevision, preferences }`. Revision0 creates; current revision updates. Preferences use the preparation contract; unknown fields fail closed. Normalized/deduplicated/sorted preferences define the receipt digest. Current catalog membership is required for fresh commands; retirement cannot prevent owned reads or replay of the original acknowledged version. Navigation never supplies action authority.

The private response is `{status: EXECUTED|REPLAYED, orientation: {version:v1,state:RECORDED,revision,recordedAt,preferences}}`. Reads return that orientation or null. No account, participant, session, receipt, audit, wallet, balance, assessed skill or permission record is serialized. Portfolio URLs are pointers only: no fetch, ownership/content assessment or public publication.

## Dependency and host contract

Node22.12+, zod4.6.5, standard URL/Intl, shared contracts (including bs58), `identity-storage` (which imports `identity-locks`), `identity-locks`, `command-receipts`, PostgreSQL16 and owned additive migrations. The domain imports no Next/Prisma/app database/configuration singleton. A compatible PostgreSQL `CommandReceiptTransaction` supplies parameterized SQL, Date timestamps, POSTGRESQL dialect and actual READ COMMITTED isolation. Its connection must support interactive transactions and the documented constraints; declaring a string without checking the actual transaction is insufficient.

The host owns begin/commit/rollback, timeout, bounded whole-transaction retries, authenticated cookie/origin/input/rate policy and configuration. Supply the SAME actual connection for receipt, identity and preference work. Claim receipt before row locks; acquire User FOR NO KEY UPDATE, then own Session FOR SHARE; hold both through commit. Read `clock_timestamp()` after locks (Session's existing expiresAt is UTC timestamp without timezone). Recheck after potentially waiting for HUMAN provisioning, and for receipt replay, which skips the handler. No provider/network calls under locks. Never derive actor/account/session/rank from browser JSON.

## Entity and state ownership

`RaiderPreferenceVersion` owns immutable own-account/participant/revision/preferences/receipt/actor/request/UTC records. `RaiderPreferences` is a current projection referencing a version through the compound ID/account/participant/revision FK. Restrictive account/participant/receipt references, unique account revision and receipt, structural payload checks, immutable versions/identity and sequential projection guards prevent reassignment, overwrite and invalid pointers. A deferred commit guard requires the corresponding finalized SaveRaiderOrientation receipt, projection and private audit.

The existing canonical HUMAN mapping is explicitly reused/created only on a valid save, never on sign-in, GET or a rejected command. No backfill or rewrite of existing wallets, campaigns, capacity, financial claims or identity history. Two same-revision commands serialize on User and yield one winner/one REVISION_CONFLICT; rollback removes every partial receipt/version/projection/audit/new mapping. Duplicate receipt keys serialize before User locks.

`identity.onboarding_recorded.v1` has identifier-only `{orientationVersionId}` payload, own aggregate/account/revision/request, and publish=false. Preferences/portfolio content never enters general logs, audit payloads, outbox, public HTML/API/search/notifications. Adding this optional shared identifier preserves existing event semantics.

## Errors, retry and recovery

OrientationStorageError codes: INVALID_INPUT, WRONG_ACTOR, UNAUTHENTICATED, ACCOUNT_RESTRICTED, REVISION_CONFLICT, STORAGE_CONTRACT, STORAGE_UNAVAILABLE. Preparation errors remain INVALID_INPUT/INVALID_HOST_CONTRACT. WRITES_DISABLED refuses new mutations when the trusted host passes allowNewWrites=false; owned original receipt replay still succeeds after current-session authorization, even without a current catalog. The optional module capability defaults true for explicit independent hosts; the application always supplies its default-off configuration. Receipt errors preserve IDEMPOTENCY_KEY_REUSED and RETRY_TRANSACTION; adapters classify failures by code, without exposing driver details. A failed port is not a successful empty read. A same-key/same-semantic-body replay returns its original immutable response after later edits; different body conflicts. Retry the entire actual transaction using the same identity; never replay only its final insert or replace the key after unknown success.

Cancel before begin where possible; interruption/failure rolls back. Once acknowledgment may have occurred, retry the original key/body. Timeouts, restore and operational failures cannot manufacture recorded completion, change payout or grant rights. Monitor safe request IDs, category, retry/conflict counts and resource cleanup; do not log bodies, cookie/hash or portfolio URLs.

## Migration and rollback

`202610130001_raider_preferences` is additive; every prior migration remains unchanged. Apply the dependency chain normally with prisma migrate deploy. The independent host explicitly provides its own minimal User/Session schema, Participant mapping/composite key and receipt/audit schema before the new owned migration. Runtime schemas own IANA timezone, credential-free HTTP(S) URL and current catalog validation; SQL additionally enforces strict payload shape/field types and provenance/revision/audit boundaries. Prisma models represent ordinary tables/keys; SQL owns custom checks/functions/triggers. Verify actual catalog and schema drift against fresh PostgreSQL.

Rollback the application by disabling new writes; retain acknowledged versions, projection, receipts/audit and canonical mapping. Dropping these records loses retry memory and is not an application rollback. Account deletion/anonymization, bounded retention and durable restore remain O11/G10 OPEN before dependent live operation. Immutable versions prevent silent overwrites; they do not adopt indefinite production retention or promise a recoverability target. No approved privacy or recovery policy is inferred.

## Consuming example

[The independent PostgreSQL host](../examples/raider-preferences/README.md) declares its own pg8.23.1/zod4.6.5/bs58/tsx dependencies, minimal schema and copied migrations/module interfaces. It independently installs; uses a fresh dedicated loopback database; saves/reads, updates, replays the original version, rejects changed body/foreign session, retries rollback, and proves one stable HUMAN with no public outbox. This alternate real driver exercises the same transaction contract without hidden RAID state or Prisma dependencies. Synthetic fixture output supplies no independent task reviewer or live-provider acceptance.

## Verification and remaining work

Genuine catalog/save RED precedes DDL/service. Real PostgreSQL tests cover protected reads, foreign authority, suspension/revoke/expiry during observed distinct-backend lock waits, database clock after Session waits, duplicate/revision races, rollback/retry, original-version replay after edits/catalog retirement, FK/provenance/payload/immutability/audit guards, and preserved HUMAN/payout. Evidence is under `planning/task-evidence/T008-preferences`; record final source, actual results and failed attempts in its task report.

The API/form host follows this storage contract and retains default-off new writes until its declared configuration/readiness is supplied. Actual starter work, trials/assessment, business privacy/retention/recovery, paid commitment prerequisites and full criterion acceptance remain NOT VERIFIED.

## HTTP and form host

The application composition root is src/lib/raider-onboarding-host.ts. GET/POST /api/v1/me/orientation use current own server cookie/account, never browser identity. GET returns version/owned orientation/public catalog/write capability. POST requires exact configured Origin, authenticated own cookie, per-account rate limit, opaque Idempotency-Key, JSON content type, strict input and expectedRevision. Stream input is bounded to16384bytes including absent/lying Content-Length and a5000ms total read deadline; errors and successful responses have private,no-store and Vary:Cookie. Malformed/privilege input422, auth401, forbidden403, conflict409, rate429, oversized413, media415, timeout408, unavailable503. Errors use the shared fixed envelope/request ID without logging private driver messages.

RAIDER_ONBOARDING_ENABLED defaults off unless exactly true; valid RAIDER_ONBOARDING_CATALOG JSON is an explicit host bootstrap list of stable IDs/labels, not assessed skill policy. Demo blocks creation. Missing/malformed/duplicate/injected catalogs fail closed for new writes; owned reads and original command replay remain available. No configuration enables starter tasks, trials, assessment, capacity, money, provider linking or paid eligibility.

/raider/onboarding renders authenticated private data; anonymous HTML gives sign-in only. Account links to it. RaiderOrientationForm is a framework-free React19 component with explicit state, injectable OrientationTransport.save/read and optional host browseLink; the Next page injects its own routing link. The host owns theme/classes/layout (orientation styles in globals.css) and cookie/origin/transport. Browser-safe input/DTO schemas have their own storage-contracts/host-contracts entry points and import no server receipt/crypto dependency.

The form preserves draft and the exact key/body across unknown success; fields stay fixed until the original retry resolves. Known revision/idempotency conflicts require reloading the saved revision while preserving the draft before a new key. An error receives focus after React commits it, and status is announced. Current saved state determines next-step messaging; actual starter/trial/portfolio assessment remain explicitly unavailable. No browser state supplies rank, permission, payout or a work slot. Verified desktop/mobile cases and independently installed React SSR host supplement the storage consumer; they are not representative UAT or independent acceptance.
