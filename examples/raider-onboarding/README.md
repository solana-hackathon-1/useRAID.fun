# Independent Raider orientation host

This synthetic CLI consumes [the preparation module](../../docs/raid-raider-onboarding.md) through copied public interfaces. Own dependencies: Node22.12+, zod4.6.5 and tsx4.23.15. `module` and `contracts/ids.ts` link to canonical sources; use `cp -RL` to create a self-contained copy. No app singleton, database, environment file, credential or provider is used.

```sh
cp -RL examples/raider-onboarding /tmp/raid-raider-onboarding-example
cd /tmp/raid-raider-onboarding-example
npm install --ignore-scripts --no-audit --no-fund
npm start
```

The host declares a small synthetic catalog/route registry, prepares a beginner and experienced trial plan, and verifies unavailable portfolio navigation stays explicit. JSON flags prove no persisted orientation completion, skill rank, work slot or payment authority. The fixture does not implement a live starter/trial/portfolio provider and cannot pass a release gate. An application host must supply actual scoped capabilities, protect stored preferences and recheck every real action. Storage/authentication/UI integration remains the next T008 phase; full T008 acceptance is NOT VERIFIED.
