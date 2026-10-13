# Independent private project-proposal host

See [the module contract](../../docs/raid-project-proposals.md). Copy with canonical links dereferenced into an available new directory, install the declared exact pg/zod/bs58/tsx dependencies, and run against a fresh dedicated loopback PostgreSQL database named useraid_project_host_test. Node22.12+, no Next/Prisma/auth singleton, live provider, wallet key or unrecorded environment required.

```sh
cp -RL examples/project-proposals /tmp/raid-project-proposal-host
cd /tmp/raid-project-proposal-host
npm install --ignore-scripts --no-audit --no-fund
# Set DATABASE_URL to the owned loopback useraid_project_host_test database (no production).
npm run migrate
npm start
npm run form
```

Host schema supplies only User/Session. Three canonical owned SQL migrations create receipts/private audit, drafts and pending proposal versions. The host adapts its own pg transactions to the stable READ_COMMITTED port and maps40001/40P01 to whole-transaction retry. It prepares a private draft, creates/updates an existing-project pending claim, checks normalized HTTPS references, current cookie denial, changed-key conflict and original receipt replay when writes are disabled. An intentionally rolled-back attempt commits exactly once; expected3proposal versions/1projection/4private audits/0outbox.

All output is synthetic and declares no actual project approval/Founder/Guild/token/grant/public/capacity/money authority. Proposed references are stored without fetching or verifying them. Future approval/challenge/nonce/recognized-asset uniqueness/history/provider/UI/UAT/gates remain NOT VERIFIED. CLI clients release in finally and pool ends; the host owner must stop its uniquely owned database after success/failure/interruption, retaining source/logs/data/evidence and preserving unrelated services. No cleanup deletes immutable records or package publication occurs.

The same independentlyinstalled host now consumes [portable private HTTP](../../docs/raid-project-proposal-http.md): injected actor/origin/rate/pgread-save/requestID, ownGETcurrent3rdversion, originalPOSTreceipt replay whilewritesdisabled/privatecache headers andforeign-origin403. This deterministichost supplies a no-op rate limiter only for synthetic fixture execution; real hosts declare persistent rate/CSRF/cookie/error/commit policies. Additionalcanonical HTTP/error/client-schema/sharedbody links are copied and dereferenced; no Next or hiddenserver state is required.

The [React form contract](../../docs/raid-project-proposal-form.md) additionally declares React19.3.0/ReactDOM19.3.0. `npm run form` renders the canonical component with explicit synthetic transport and checks semantic labels, empty private state, enabled/disabled fieldsets and absence of hidden auth state. The transport throws if SSR unexpectedly sends a request. This independent consuming copy has its own node_modules; no root Next/Prisma singleton is required. Browser behavior and current-owner permissions are verified separately against the root's synthetic protected API. The React example does not establish project authority or durable recovery across a page refresh.
