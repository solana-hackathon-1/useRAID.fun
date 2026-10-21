# Practice trial portal — consuming host

Independent synthetic host for `PracticeTrialCatalog`/`PracticeTrialWorkspace`. It imports only the
portable component, `practice-portal-client` and owned contracts (symlinked from `src/`), declares
its own React/zod dependencies and renders with an injected transport. No RAID app, database,
environment, session or network is used.

```sh
npm ci && npm run typecheck && npm start
```

Expected JSON: every flag `true`. See [practice portal UI](../../docs/raid-practice-portal-ui.md).
