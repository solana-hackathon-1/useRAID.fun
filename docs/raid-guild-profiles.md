# Guild profile preparation, public projection and scoped policy

## Purpose and status

T009A is an unwired v1 contract under R01–R04/R10/R15/R16, I06/I07/I10/I13, AC07/AC73–75 and blueprint05–07/09–10/13/24–30/33/34M1. No storage, API, Guild creation, actual role grant, founder verification, token recognition, public release, history, work/capacity or financial effect exists in this phase. Full T009, independent review/UAT and the protected audited storage/project-control dependencies remain NOT VERIFIED. This library's passing policy tests do not prove a real cross-Guild write or resource boundary.

The existing repository has legacy User.role/creator/X allowlist and Token.metadataSource=MARKET display identity; these cannot supply Guild founder/control authority. No actual Guild/profile/grant model exists. Shared GuildSchema/PublicGuildSchema/opaque IDs and exact token-asset shape are reused, without rewriting existing account/campaign/wallet/financial data.

## Public interface and owned fields

prepareGuildProfileDraft(input) accepts strict public name/slug/description using the shared bounds and stable slug syntax, trimming before validation. It returns frozen DRAFT_PROPOSAL/persistedfalse/founderControlVerifiedfalse/createsPermissionGrantfalse and primaryTokennull. It issues no IDs, badge or authority. Uniqueness and stable persisted slug still require the eventual database contract.

projectPublicGuildProfile(record) consumes trusted versionv1, GuildSchema, approved PublicGuildSchema, publicProfileApproved and optional privateContext. Approval is an actual host-owned publication decision, never a browser boolean. Unapproved fields fail PUBLIC_PROFILE_UNAVAILABLE. Guild ID and exact token identity must agree between record and public projection. Explicit shared allowlist outputs only ID/slug/name/description/primaryToken; founder account, role grants, repositories, private configuration/roadmap/contact, payment administration and notes never copy into JSON/HTML/search/previews/events. Values are text; consuming UIs escape them rather than execute markup. Shape validation is not founder/project or chain verification.

Current profile-editable fields are name/description. Stable slug, founder ownership, recognized token, private configuration, rewards, skill rank and permission records are outside this v1 field-edit scope. Media/links/progress updates, storage/publication and verified badges need their complete later contract; absent fields are not claimed implemented.

## Profile permission facts and decisions

evaluateGuildProfilePermission(facts, request) returns frozen versionv1/allowed/reason/informationaltrue/isAuthorizationTokenfalse/persistsfalse. It evaluates EDIT_PROFILE or DELEGATE_PROFILE over explicit supported fields, target Guild and current expected revision. Unknown actions/fields fail closed, including treasury, dispute decisions, code/download access, ownership transfer and token changes. Those domains retain separate authority even for a verified Founder.

Trusted host facts contain current Guild relationship/revision, stored founderControlVerified, authenticated own actor account/session authority, restriction, UTC clock and live granted records. This verification flag means a current established authorized project relationship, not MARKET metadata, a wallet signature alone, an optimistic client badge, or a transient RPC observation. The actual project/control evidence is a host dependency. An unverified relationship, restricted/unauthenticated actor, wrong Guild or stale revision denies applicable actions.

A verified own Founder may edit/delegate only these profile fields. Another account needs current same-Guild/same-subject ACTIVE grants for every requested field, with explicit canDelegateProfile for redelegation. Grant IDs must be unique; contradictory stale/current duplicates are an INVALID_HOST_CONTRACT rather than additive authority. Every applicable grant starts no later than the supplied clock and expires strictly after it (nullable expiry is an explicit host grant, not a new lifetime policy chosen here). Revoked, foreign, future and expired grants supply no scope.

holderEligible is a separate nullable observation and never grants or removes profile authority. Unknown membership is null; existing explicit role permission remains independent. Legacy global User.role/admin allowlists and scores do not enter this strict facts schema. Owning tokens, earning rank or holding a Founder badge cannot bypass real resource/treasury/dispute checks.

## Clock and authentication host dependencies

Runtime: Node22.12+ or equivalent standard Date/URL, zod4.6.5, shared contracts including bs58; no Next, Prisma, application singleton, credential or provider SDK. v1 grant clock/start/expiry are UTC timestamps with at most millisecond precision, including equivalent valid forms with omitted/short fractions. Comparison uses parsed instants, not lexical strings. Finer precision fails closed to prevent early authority through truncation; a host with finer timestamps must preserve conservative database boundary semantics, not silently round into permission.

The command host resolves current own session/account and immutable Guild/grant/project-control records at its real authorization boundary. It owns transaction/isolation, documented lock order, database clock read after locks, restriction/revoke races, semantic receipts/revision, private audit/outbox and rollback. Rebuild facts inside that boundary; do not cache this informational result as later authorization. Browser input may identify permitted edit/fields/revision, never actor/control/grants/clock/holder/admin authority. Recheck replay authority and preserve acknowledged immutable results in eventual storage.

A different fact/projection adapter must supply equivalent authorized current records, exact token identity and typed availability. Missing/inconsistent approval, clock or proof fails closed; no success-shaped fallback. Public/private classification and record provenance survive swaps. No HTTP/provider/LLM/finality wait belongs under database locks.

## Errors and recovery

GuildProfileContractError has fixed INVALID_INPUT, INVALID_HOST_CONTRACT and PUBLIC_PROFILE_UNAVAILABLE codes. Private input/provider details are not logged or embedded in error messages. Policy reasons are ALLOWED, AUTHENTICATION_REQUIRED, ACCOUNT_RESTRICTED, WRONG_GUILD, REVISION_CHANGED, UNSUPPORTED_ACTION, UNSUPPORTED_FIELD, FOUNDER_VERIFICATION_REQUIRED and PERMISSION_NOT_GRANTED. A denial changes nothing. Hosts refresh current authoritative facts/approved version before retry; this library has no stored effect, cancellation, external operation, durability or migration to reconcile.

## Independent consuming example and verification

[The independent example](../examples/guild-profiles/README.md) copies only canonical pure module entry files/shared contracts and declares its own zod/bs58/tsx installation. It demonstrates approved public projection, no private bytes, holder denial, alternate trusted host with a narrowly granted field, unknown membership independence, expired/revoked denial and treasury separation. Synthetic control facts are clearly fixtures, not real verified projects or grants.

Meaningful tests precede implementation: executable stub29cases28fail1pass, then scoped projection/policy. Retained first implementation invalid future-range fixture failure; corrected valid future-grant fixture without weakening denial. Equal-instants lexical comparison RED precedes numeric time comparison. Finer-than-ms, duplicate conflicting grants and unknown-member behavior each have genuine RED before their fixes. Same-change doc/example acceptance is defined before creation. Record actual final results/source and independent install under planning/task-evidence/T009-contract; full criterion packet remains incomplete.

No database/schema/API/UI/runtime flag or provider/money permission changes in this phase. Rollback removes only unwired preparation/policy contracts; any future persisted acknowledged ownership/grants/history must be retained under reviewed recovery/retention. O11/G10 and T010 actual project-control/token verification remain unresolved before dependent live actions. The next bounded implementation defines protected audited Guild draft/version/field-delegation storage and real self-session/resource authority, including direct denial/revoke/concurrent revision/replay/FK/privacy cases; no fabricated Founder verification or treasury transfer process.
