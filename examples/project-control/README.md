# Independent existing-project control host

See [the full module/API/security contract](../../docs/raid-project-control.md). This synthetic Node22.12+ host dereferences only the canonical control-proof files and shared asset/identity contracts, then installs its own zod4.6.5, bs586.0.0, tsx4.23.15 and tweetnacl1.0.3. No environment variable, Next, Prisma, RPC/provider SDK, database, app auth singleton or live credential is required.

```sh
cp -RL examples/project-control /tmp/raid-project-control-host
cd /tmp/raid-project-control-host
npm install --ignore-scripts --no-audit --no-fund
npm start
```

Use an available new destination. Canonical links avoid a divergent module fork inside the repository; the copied directory is independently executable with its own node_modules. A deterministic disposable signing seed and fabricated policy/authority/public-evidence records are test-only and never establish real project authority.

The host signs an actual purpose/nonce/origin/account/draft/exact-asset/version-bound message, substitutes an independently implemented Node crypto verifier and checks identical results. It denies foreign actor, consumed/expired challenge, revoked authority, unapproved policy, unknown public evidence, wrong network and nonce substitution. Output contains synthetictrue and seven observed boolean checks; it exposes no seed/signature/challenge secrets. Each process exits with no server/container/pool to stop.

Results remain informational and do not consume a nonce, persist a record or create Founder/Guild/token/grant/money/capacity authority. The repeated AVAILABLE evaluation deliberately proves that atomic replay prevention is not implemented here. Real hosts must load approved/current policy/authority/evidence and authenticated own resource facts, then reauthorize/atomically consume the challenge and immutable receipt under recognized-asset uniqueness before any separately approved recognition command. Approved routes, permanent authority revocation review, governance quorums, full recognition/history/provider/UI and independent UAT remain NOT VERIFIED. No live enablement or package publication is authorized by this example.
