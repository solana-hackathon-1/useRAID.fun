# Party rosters, exact splits and member consent (T056)

Module: `src/parties` (`createParty`, `proposePartyRoster`, `recordPartyMemberConsent`, `readPartyProposal`, `evaluatePartyCoverage`). Migration `202610290002_parties`. Consuming example: [`examples/parties`](../examples/parties/README.md) (pure contracts and coverage; the storage needs a host with the RAID work tables and is covered by the real-database tests only). Blueprint §§14.2–14.4, 13, 16; invariants P02, I01–I05, I08. Simulated funds only; no flag is added because no route or UI calls these commands yet. Writes take `PartyHost.allowNewWrites` (default off in any host that does not set it); replays and reads work while it is off.

## What it does

- **Party** (`createParty`): a name and a leader. The leader is the commanding human's own participant, enforced by a database trigger on the command receipt. The label carries no skill, consent or payout.
- **Roster proposal** (`proposePartyRoster`, leader only): an immutable snapshot of members, roles and per-asset allocations for one available slot whose current terms are `execution: PARTY`, naming the exact terms digest. Each member has one allocation per reward leg, as integer base units; the sum must equal the leg's amount exactly, with no dust and no shortfall (`INVALID_INPUT` otherwise; percentages and a rounding policy are not implemented, see gaps). The proposal digest binds party, slot, terms version and digest, and every role and amount. A deferred constraint trigger re-checks the sums at commit, so a direct writer cannot store a roster that does not add up.
- **Member consent** (`recordPartyMemberConsent`): the commanding human's own consent to one proposal's exact digest. The input names the proposal and digest, never a participant. A database trigger rejects any consent whose receipt's account does not own the consenting participant, so a leader cannot consent for another human even through a coding mistake. Someone outside the roster gets `NOT_FOUND`; a different digest gets `REVISION_CONFLICT`; consent is refused once the slot is not available, the terms are no longer current or the commitment deadline passed. Append-only; a repeat keeps the one consent.
- **Read** (`readPartyProposal`): leader and named members see the roster and each member's consent state and `allConsented`; anyone else gets `NOT_FOUND`.
- **Coverage** (`evaluatePartyCoverage`): wraps the private skill eligibility explanation. The context must contain exactly the roster's members, each with their own evidence, and the coverage rule (`ONE_MEMBER`, `DISTRIBUTED_PARTY`, `EVERY_MEMBER`) is explicit. A leader's rank or a participant outside the snapshot never counts for another member (`PartyCoverageError`).

None of it accepts work, holds capacity, binds funding, grants access or moves money. `allConsented` is not an acceptance.

## Limits and gaps (NOT VERIFIED or open)

- Publication still refuses `PARTY` terms (`UNSUPPORTED_MODE`), and Party acceptance, atomic multi-member capacity, vacancy and replacement are separate tasks (T057, T025 follow-ups). Tests re-label the stored terms of a published slot to exercise the storage; no production path creates a `PARTY` listing yet.
- Terms carry no coverage rule, so `evaluatePartyCoverage` takes it as input; where it is stored (terms version, listing) is an unmade decision. Nothing yet requires the coverage result before a proposal is accepted.
- Only HUMAN members. An AI operator's consent for its registered worker is a later slice.
- No percentage drafting or rounding policy: the blueprint requires a disclosed deterministic policy and none is recorded, so allocations must already be exact. Beneficiary identities and verified payout destinations are not frozen here (payout destinations do not exist yet).
- No profile evolution (members added or removed on a reusable Party), no member replacement amendment, no dissolution, no HTTP route, UI, notification or per-member eligibility read from live evidence.
- Suspension of a member is checked when the roster is proposed and by the member's own session at consent; acceptance must recheck current facts.
- Independent review, UAT and business/release evidence are NOT VERIFIED.
