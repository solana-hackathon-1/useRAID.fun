# Runtime configuration validator example

Standalone host for `src/config-validation` (`config-validation` is a link to it). It passes synthetic environments to `validateRuntimeConfig`/`assertRuntimeConfig` and checks: nothing configured is safe, a real-operation switch without its authority is refused by variable name only, mistyped high-impact switches are refused while routine ones warn, test modes are refused in production, and signer secrets are refused on the web role. It reads no environment, database or provider.

```sh
npm install && npm start
```

See [module reuse](../../docs/raid-module-reuse.md#configuration-validation-config-validation).
