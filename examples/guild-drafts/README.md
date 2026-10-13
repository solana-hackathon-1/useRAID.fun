# Independently installed private Guild draft host

Read [the module contract](../../docs/raid-guild-drafts.md). This private synthetic pg host owns its minimal User/Session tables, cookie-hash fixture, real PostgreSQL READ COMMITTED transactions and explicit write permission. No Next, Prisma, app credentials, token/provider or financial SDK is required. Node22.12+; exact own pg8.23.1/zod4.6.5/bs586.0.0/tsx4.23.15 packages.

```sh
cp -RL examples/guild-drafts /tmp/raid-guild-draft-host
cd /tmp/raid-guild-draft-host
npm install --ignore-scripts --no-audit --no-fund
# Supply your own loopback-only disposable database named useraid_guild_host_test.
export DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:55443/useraid_guild_host_test
npm run migrate
npm start
```

The example validates the exact synthetic database name/local host and refuses production. Copy dereferences only curated canonical files, shared contracts and receipt module/migrations. The host owner supplies and stops their own database; CLI pool connections close in finally. Never use an existing app/staging database or copy real credentials.

Output proves real private save/read, update, immutable replay, changed-body conflict, foreign-session denial, whole-transaction retry and one projection/version per acknowledged command without outbox/public authority. DRAFT_UNVERIFIED does not grant a Founder badge, token recognition, administration of a real Guild, treasury, private access or public listing. The example is not independent criterion review or UAT; full T009 remains NOT VERIFIED. Rollback/recovery retains acknowledged history under reviewed policy.

The same installed host now consumes the framework-free createGuildDraftHandlers v1 interface with actual Node Request/Response and the real database, verifying HTTP private save/read/original replay/no Founder authority and foreign-origin403. Its current synthetic actor/origin and non-enforcing rate fixture are explicit host test dependencies; root Next uses actual cookie authentication and a persistent30/minute limiter. See [HTTP contracts](../../docs/raid-guild-draft-http.md). No Next or root application import is copied.

`npm run form` renders the framework-free React form with the host's own React19.3.0/ReactDOM19.3.0 and react-jsx configuration. It verifies semantic private name/URL/description fields, explicit unavailable state and no hidden HTTP request; no Next/auth/Prisma/global app dependency. Supply orientation utility styles or equivalent in a browser host. Actual desktop/mobile interaction uses the root's isolated owned fixture, not SSR. See [form contract](../../docs/raid-guild-draft-form.md).
