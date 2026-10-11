# useRAID VM staging deployment (v1)

Owner decision: [DEC-2026-10-11-01](../RAID_AGENT_BLUEPRINT.md#029-accepted-staging-deployment-choice--11-october-2026). Bounded T005 deployment slice, AG09/AG10, M0. R15/R16/D01/D12/I05/I06/I09/I10/I12/I13; AC67/AC68/AC73–AC75. This contract changes deployment orchestration, not canonical User/Session/Raid/Job/ledger identity, permissions, accepted terms, capacity, claims or payout destinations. Existing Prisma migrations are applied unchanged to a separate staging database. Full T005 and production gates remain independent obligations.

The selected VM is `raidstaging@192.168.101.13`, Ubuntu 26.04.1, ARM64, Docker 29.9.0 / Compose 5.6.0. Existing Dokploy, Traefik, Swarm and database services occupy 80/443/3000; preserve them. Staging owns `/home/raidstaging/useraid-staging`, Compose project `useraid-staging`, its default bridge network and PostgreSQL volume. Only its HTTPS proxy publishes a port: `192.168.101.13:8443`. Database, web, worker and Watchtower publish none. The private LAN URL is `https://192.168.101.13:8443`; it is not a public domain.

## Artifact and startup contracts

```text
main push → Staging image workflow → checked ARM64 image → private GHCR
                                                       ↓ poll every 300 seconds
                            Watchtower → web + worker replacement
                                           ↓ migrate before process start
                                   isolated PostgreSQL 16
Browser → HTTPS proxy → web; worker → durable database jobs
```

[The workflow](../.github/workflows/staging-image.yml) runs planning/deployment tests, typecheck, lint, dependency audit, real-database migrations/tests, production image build and image smoke before obtaining registry credentials and publishing. It uses the native `ubuntu-24.04-arm` runner. This artifact supports ARM64; an x86 host needs its own tested architecture build. Existing `Checks`/status workflows remain manual. Hosted runner access/minutes are host dependencies: a billing/startup failure must be resolved, never bypassed to publish.

[Publication v1](../scripts/staging-publish.sh) accepts a checked local image and `GITHUB_REPOSITORY` / 40-character `GITHUB_SHA`, publishes `ghcr.io/solana-hackathon-1/useraid.fun:sha-<full-sha>`, checks current remote main, and promotes `:staging` only if still current. The workflow serializes publications and labels the image with source/revision. The immutable SHA tag supports an explicit rollback. A failed push exits nonzero; a superseded build skips promotion. Registry authentication is owned by the workflow's repository-scoped `GITHUB_TOKEN` (`contents:read`, `packages:write`), not a VM key or personal signer. The build context excludes `.env*`, `.git`, tests and provider credentials.

[Startup v1](../scripts/staging-start.sh) accepts exactly `web` or `worker`, runs `npm run db:migrate`, then `exec`s the appropriate Node process. Unknown roles exit 64 without touching the database. Migration failure retains its nonzero result and never starts the application; Docker restarts the container. Prisma's advisory lock serializes migration attempts; a lock timeout also fails closed/retries by container restart. The same startup command is retained when Watchtower replaces a container; Compose's initial `depends_on` is not assumed to run during Watchtower updates. The worker also retains its existing schema check and durable job/lease handling. Node receives termination signals directly; stop grace is 60 seconds.

Watchtower updates only containers with both the explicit enable label and `useraid-staging` scope. It includes restarting application containers so a bad-image restart loop can receive a corrected image. Database, proxy, watcher and unrelated Dokploy services are excluded. Watchtower has Docker-daemon authority through its socket; no application container receives that socket. Its private registry configuration is a directory mount (read-only), allowing token rotation without an inode-stale single-file mount. Docker API version 1.44 is explicit and must be verified against any replacement host. Database/proxy/Watchtower base images are digest-pinned. The upstream Watchtower repository is archived; version 1.7.1 is the selected compatibility baseline, not an assurance of ongoing maintenance.

Automatic rollout is not atomic across web and worker, does not wait for application health before promoting the other process, and does not roll back failing migrations or application images. All automatic migrations must remain backward compatible with the prior running revision. Destructive/incompatible changes require pausing Watchtower, a reviewed backup/migration plan and an operator-controlled coordinated rollout. Environment, proxy and Compose changes require an explicit `docker compose up -d`; changing an image does not deploy host configuration.

## Host dependencies and credential ownership

An independently consuming host needs ARM64 Linux, Docker/Compose, outbound registry access, the configured free bind address/port, persistent storage, trusted TLS, a named operator and separate staging credentials. Source checkout is optional. No hidden application singleton or provider installation is needed for the disabled initial scope.

| File under `STAGING_ROOT`              | Purpose and access                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env`                                 | Compose variables: root, bind address, HTTPS port, Docker API version and optional image override; mode 600.                                                              |
| `.env.app`                             | Staging-only `DATABASE_URL`, canonical `NEXT_PUBLIC_APP_URL`, explicit `USDC_NETWORK=devnet`, official handle; mode 600.                                                  |
| `.env.web`                             | Staging X OAuth client/secret and immutable admin IDs when separately supplied; mode 600. No worker signer keys.                                                          |
| `.env.worker`                          | Staging provider credentials if separately enabled; mode 600. No production keys or accounts.                                                                             |
| `secrets/db-password`                  | Cryptographically random PostgreSQL password, mode 600; distinct from every existing database.                                                                            |
| `registry/config.json`                 | Dedicated GHCR classic token with `read:packages`, correct package access and organization SSO if required; mode 600, directory 700. No CLI credential helper dependency. |
| `tls/fullchain.pem`, `tls/privkey.pem` | Origin-matching certificate/SAN and private key, key mode 600. Replace private certificates with trusted certificates when a DNS hostname is selected.                    |
| `compose.yaml`, `nginx.conf`           | Copies of the versioned repository configuration, updated deliberately.                                                                                                   |

Repository SSH deploy keys are disabled by GitHub policy. A dedicated Ed25519 key was generated on the VM, but GitHub rejected registration (HTTP 422); it is unused and conveys no repository access. Do not weaken the policy or put the owner's GitHub/SSH private key on the VM. Image-only deployments do not require source access. An SSH deploy key also cannot authenticate GHCR. GitHub's [registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) specifies the distinct package token requirement.

Compose forces `DEMO_MODE=false`, `ACCOUNT_FOLDS_ENABLED=false`, `WALLET_LINKS_ENABLED=false`, `LOCAL_AUTO_APPROVE_CREATORS=false`, `STUDIO_SANDBOX=false`, `ALLOW_REMOTE_TEST_DB=false`, `LIVE_COLLECTION_APPROVED=false`, `X_TRACKING_V2_ENABLED=false`, `X_TRACKING_V2_SETTLEMENT_ENABLED=false`, `LAUNCH_ENABLED=false` and `PAYOUT_ENABLED=false`. Do not infer live authority from `NODE_ENV=production`, the health endpoint's legacy `mode:live` label or a successful deployment. No RPC, funding address, rate or signer is supplied. No production data is imported. Finance/provider enablement requires its separate accepted gates and configuration change.

Nginx terminates HTTPS, overwrites `X-Forwarded-For` with the socket peer and forwards the canonical host/protocol; only web trusts that header. Docker DNS is refreshed so a replacement web IP does not strand the proxy. The initial certificate is private/self-signed, valid for IP `192.168.101.13` and hostname `raidstaging`; browsers need explicit trust. It expires 9 January 2027 and must be renewed before then. Do not use `curl -k` as evidence of certificate authenticity; use the recorded certificate as the CA file for verification.

## Minimal independently runnable consuming example

On a separate authorized host, prepare the files above with synthetic staging credentials, set `STAGING_ROOT`, the available bind/HTTPS port and matching origin/TLS, then copy `compose.staging.yaml` to `$STAGING_ROOT/compose.yaml` and `deploy/staging/nginx.conf` to `$STAGING_ROOT/nginx.conf`. Never copy a production `.env`. The VM's root is the path stated above.

```sh
cd /home/raidstaging/useraid-staging
# Authenticate using a dedicated pull token on stdin; never put it in arguments.
docker --config ./registry login ghcr.io -u GITHUB_USERNAME --password-stdin < /private/path/pull-token
chmod 600 registry/config.json
docker compose --env-file .env pull web worker
docker compose --env-file .env up -d --wait db web worker proxy
# Start automatic updates only after private GHCR access/publication is verified.
docker compose --env-file .env up -d watchtower
docker compose ps
curl --cacert tls/fullchain.pem https://192.168.101.13:8443/api/health
```

The initial VM bootstrap image was built from committed main `5e8080f2a4abe39854bbc00f340f288d273540bb` plus the uncommitted startup script, then loaded over SSH. Its local build ID is `sha256:fff447cc84e63e0c77cbb04b773db342898b4fb496f755ccda668d9046b1b69c`; VM Docker loaded it with OCI manifest ID `sha256:6499e100805bf00e16b301cbaaa6bc8701b45c93903a814dc766740ac13caa42`, with matching RootFS/Config. It is explicitly labeled as an uncommitted staging bootstrap; that label/source must not be represented as a published Git commit. The owner explicitly authorized scoped Git publication after preparation; the workflow becomes active on that main push. Actual publication/run identity is recorded in CURRENT.md. That initial gate is now satisfied: owner-authorized main `e492c39ef2c5356a490bb5fdcd31b12beaf4a248` passed hosted publication, and dedicated private pulls and an actual Watchtower replacement succeeded. The permanent updater runs every300seconds. See the task/checkpoint for exact runtime evidence; a future consuming host must verify its own initial access before starting the watcher.

For credential-free contract tests, run `python3 -m unittest discover -s tests -p 'test_raid_staging.py'` from the repository. Startup/publication tests use executable substitute host commands; the Compose consumer renders a separate synthetic host with real Docker Compose without touching Docker containers. Failure tests cover migration denial, unknown role, failed registry push and superseded main. The VM runtime/build evidence is separately recorded in [the task](tasks/2026-10-11-vm-staging.md).

## Monitoring, backup and recovery

```sh
cd /home/raidstaging/useraid-staging
docker compose ps
docker compose logs --tail 100 web worker watchtower
# Restricted local backup; no URL/password in arguments or logs.
umask 077
docker compose exec -T db pg_dump -U useraid -d useraid_staging --format=custom > backups/staging.dump
docker compose exec -T db pg_restore --list < backups/staging.dump > /dev/null
```

Check `/api/health`, migration failures, worker restarts/Job failures and Watchtower's actual update summaries; web health does not prove job processing or provider access. Rotate the read-only registry token by logging in to the same dedicated config directory; verify the next authenticated pull. The current VM token expires10November2026 at11:22:08UTC. Its value is never included here or in evidence. The VM currently has2.5GB free/85%used after retaining the bootstrap image and published artifact; expand capacity or deliberately retire only owned unused staging images before frequent builds consume the remaining space. No shared/global image prune is authorized by this runbook. Watchtower's [registry configuration](https://containrrr.dev/watchtower/private-registries/) and [selection/API options](https://containrrr.dev/watchtower/arguments/) define this host contract.

Pause only this stack's updater with `docker compose stop watchtower`. To roll code back, set `STAGING_IMAGE=ghcr.io/solana-hackathon-1/useraid.fun:sha-<known-good-full-sha>` in `.env`, pull and recreate web/worker, then verify health, migrations and jobs. Keep Watchtower stopped while pinned. To resume following main, remove the override and recreate web/worker before starting the watcher. Do not delete the database volume or pretend a code rollback reverses migrations, transfers or grants. Failed migrations require diagnosis/authorized repair; never edit applied migrations or mark one successful without evidence.

Backups on this VM are in the same failure domain and are not production disaster recovery. A bootstrap backup restored to an isolated database with all22 migration rows and one Settings row; that test database was then dropped. Off-host encrypted retention, acknowledged-effect recovery and durability/support/SLO ownership remain required before real commitments, provider effects or funds. To stop only owned staging containers, run `docker compose -p useraid-staging -f /home/raidstaging/useraid-staging/compose.yaml --env-file /home/raidstaging/useraid-staging/.env stop`. Preserve volumes, Dokploy and all other listeners. No production acceptance, independent criterion sign-off, UAT or G01–G10 completion is inferred.

## Public preview extension

Owner-requested internet access uses the [named Cloudflare Tunnel overlay](staging-public-access.md) at `staging.useraid.fun`. After activation, include both Compose files (host `.env` COMPOSE_FILE selects them) and use the public HTTPS origin for testing. The existing LAN certificate and image-pull automation remain separate. Live public access is not claimed until the tunnel credential is installed and checked.
