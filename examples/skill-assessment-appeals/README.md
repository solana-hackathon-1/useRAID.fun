# Independent appeal-adjudicator host

See [the complete module contract](../../docs/raid-skill-assessment-appeals.md). This private synthetic example supplies its own trusted case facts and installed zod4.6.5 and tsx4.23.15; Node22.12+. It needs no environment, database, global credentials, Next, Prisma or provider SDK.

```sh
cp -RL examples/skill-assessment-appeals /tmp/raid-appeal-adjudicator-host
cd /tmp/raid-appeal-adjudicator-host
npm install --ignore-scripts --no-audit --no-fund
npm start
```

Copy dereferences only the pure independence and window rules. Output is synthetictrue plus allowlistNecessaryNotSufficient, selfAdjudicationRefused, originalReviewerRefused, guildRelationshipRefused, malformedFactsFailClosed, windowsProvisionalAndConfigurable and noPersistenceOrAuthorityToken, all true. No synthetic fact is a real reviewer, Guild relationship or appeal.

A real host derives the facts under the actual locks (see the module document): the adjudicator allowlist from its own configuration, the original reviewers from the assessment's recorded evaluators, and Guild relationships from current Founder and role records. Returned answers are informational and cannot be supplied back as a permission token. Storage, the authenticated API, the fresh-review reopening, UAT and the owner's confirmation of the provisional 14-day windows remain NOT VERIFIED.
