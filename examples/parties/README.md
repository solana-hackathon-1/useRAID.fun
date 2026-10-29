# Standalone synthetic Party host

Consumes the portable Party contracts and `evaluatePartyCoverage` with synthetic members only. It shows that a Party label
or a leader's record never supplies another member's skill, that the consent input names no participant (the member comes
from their own session), and that a split is exact integer base units. It does not create a Party, store a roster, record
consent, accept work, hold capacity or move money; those are `parties/party-storage` and need a host with the RAID work
tables (see [the module documentation](../../docs/raid-parties.md)). Canonical module links prevent a divergent
implementation in the repository; an exported host copies their targets into its own source tree.

From this directory:

```sh
npm ci
npm run typecheck
npm start
```

Expected JSON: every flag `true`.
