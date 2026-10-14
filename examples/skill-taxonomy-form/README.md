# Independent catalog React host

Synthetic consumer for [the editor contract](../../docs/raid-skill-taxonomy-editor.md). Node≥22.12; React/ReactDOM19.3, Zod4.6.5, bs586, tsx4.23.15, TypeScript5.9.3 and Node/React types are explicitly locked. Relative links point to canonical owned sources; copy with dereferencing for an independent installation:

```sh
consumer_dir=$(mktemp -d /tmp/raid-skill-taxonomy-form-consumer-XXXXXX)
cp -RL examples/skill-taxonomy-form/. "$consumer_dir/"
cd "$consumer_dir"
npm ci
npm run typecheck
npm start
```

Expected JSON confirms synthetic portable React, no seeded categories, hydration-disabled SSR, saved identity, disabled writes, malformed-host denial and no hidden authority/dispatch. The host injects synthetic v1 state and alternate typed native-Response transport; SSR cannot dispatch it. Own node_modules is required, without a Root runtime symlink. No Next, Prisma, provider, secret, cookie, server or database is needed. No listener/resource is started; preserve source/results after exit.

SSR does not prove interaction, cookies, current permissions, durable publication, desktop/mobile accessibility or representative UAT. Root browser and real PostgreSQL checks verify their specific boundaries separately. Real hosts supply current X/admin authorization, private/no-store reads, origin/account rate, locked SQL history/receipts and explicit new-write configuration. Data props/previews never authorize a command. Keep unknown intent's page open; no credentials/draft/receipt are persisted in browser storage. Supply documented orientation/button/visually-hidden styles or equivalent accessible presentation.
