# Local braces security backport

This private package is based on the MIT-licensed npm `braces@3.0.3` release. Its local version is **3.0.4-raid.1**; it is not an upstream release or a claim of upstream approval. The original license is retained. [Provenance](provenance.json) records the registry archive integrity and original source hashes.

The [GHSA-vfj7-8cjw-p6xm advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) describes unbounded recursive AST walkers. The backport bounds structural brace/parenthesis nesting to 128 levels before parsing deeper structures and iteratively checks supplied ASTs before compile, expand or stringify. Excess nesting throws `SyntaxError` with `Pattern nesting exceeds maximum depth (128)`. This hard bound cannot be increased by options. Child cycles also reach the bound and are rejected. Escaped and quoted braces remain literal; existing range limits and ordinary output semantics are preserved. This is a targeted recursion repair, not a general resource limit for every possible expansion or malformed caller-built AST.

Changes from upstream: `lib/depth.js` is new; `lib/parse.js` checks nesting before creating brace/parenthesis containers; `lib/compile.js`, `lib/expand.js` and `lib/stringify.js` check AST depth before their recursive walks. The original `index.js`, constants, utilities and license are unchanged. `package.json` records the private local version and includes this documentation and the consuming example.

## Host contract and verification

Public API: the upstream CommonJS callable export and its `create`, `parse`, `compile`, `expand` and `stringify` methods. Low-level walkers also enforce the same bound. Dependencies: `fill-range@^7.1.1`, supplied by npm installation; no RAID configuration, database, credentials, clock or network capability is consumed. The upstream Node >=8 contract is retained; RAID runs Node >=22.12. Permission, money, work and concurrency state are unaffected.

The root development dependency uses `file:vendor/braces`; the npm override references `$braces` so micromatch/fast-glob/Next lint consume this exact package. `.npmrc` sets `install-links=true` to install the local package with its declared dependencies rather than relying on undeclared symlink resolution. Docker copies the npm config and vendor source before `npm ci`.

Repository contract tests: `npx vitest run tests/braces-security.test.ts`. They resolve the actual Next → fast-glob → micromatch → braces chain, reproduce excessive strings and ASTs/cycles, verify ordinary output, and exercise page discovery with exclusions. Application lint remains enabled. Upstream source is excluded from RAID's style lint/format rewriting to keep provenance diffs reviewable; the new security behavior is verified by executable tests.

For an independent consuming host, pack and install the package into an otherwise empty directory, then run the included example:

```sh
npm pack ./vendor/braces --pack-destination /tmp
mkdir -p /tmp/raid-braces-host
npm install --prefix /tmp/raid-braces-host /tmp/braces-3.0.4-raid.1.tgz
node /tmp/raid-braces-host/node_modules/braces/examples/consumer.cjs
```

This example demonstrates normal expansion plus safe rejection without RAID app state. Scanner success alone does not prove this patch: local source and executable regression evidence must be reviewed independently. Maintain the fork until a compatible upstream fix passes these tests; then remove the local dependency/override and vendor source together. Required security checks and allowlist rules remain unchanged.
