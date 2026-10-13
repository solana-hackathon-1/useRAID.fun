# Independent skill claim preparation host

See [the module contract](../../docs/raid-skill-claims.md). Node22.12+ with exact zod4.6.5/bs586.0.0/tsx4.23.15 and canonical shared contracts is required. Use a fresh available destination and dereference the canonical source links.

```sh
cp -RL examples/skill-claims /tmp/raid-skill-claims-host
cd /tmp/raid-skill-claims-host
npm ci --ignore-scripts --no-audit --no-fund
npm start
```

The copied host owns its installed node_modules. No Next/Prisma/auth singleton, environment, database, live credential or provider is required. Its catalog/admin/canonical participant/time facts are explicitly synthetic. It preserves old aliases and skill domains in rename candidates, keeps frontend distinct from Solana, binds claims to the same canonical HUMAN and denies foreign/wealth inputs. Claimed S has no assessed rank, confidence, sample or verification; catalog candidates are not published.

Actual host must supply current authenticated canonical identity and genuinely approved admin catalog, then implement authorized audited catalog publication and private versioned claims/evidence before live use. Assessment/rubric/evaluator/reassessment/revocation history, Root/UI/persistence/independent review/UAT/gates remain NOT VERIFIED. Each CLI exits without server/pool/container resources; retain logs/source and preserve unrelated resources. No package publication, funds, rank assignment or feature activation.
