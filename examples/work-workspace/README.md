# Work workspace — consuming host

Independent synthetic host for `MyRaidsWorkspace` and `WorkDesk`. It imports only the portable components, the
`workspace-client` and owned pure contracts (symlinked from `src/`), declares its own React/zod dependencies and
renders with an injected transport. No RAID app, database, environment, session or network is used.

```sh
npm ci && npm run typecheck && npm start
```

The synthetic `MyRaidsSchema` view supplies the required capacity summary, and per engagement the accepted terms and
setup readiness; the host renders them from injected data only.

Expected JSON: every flag `true`. See [work workspace](../../docs/raid-work-workspace.md).
