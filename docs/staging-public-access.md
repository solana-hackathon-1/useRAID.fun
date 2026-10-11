# Public staging preview via Cloudflare Tunnel (v1)

Owner outcome: open and test the existing staging application from college, a friend's home or another internet connection at **https://staging.useraid.fun**. Owner confirmed `useraid.fun` is managed in Cloudflare. This is a public preview route to isolated staging, not production or financial/provider enablement. Canonical authority: DEC-2026-10-11-02; bounded T005/AG09/AG10/M0, R15/R16/D01/D12/I05/I06/I09/I10/I12/I13, AC67/AC73–AC75 and blueprint §§24/28–30/33.11–12/35/39–40. No new User/Session/Raid/Job/ledger entity or schema; existing authentication, permissions, accepted terms, capacity and settlement rules remain unchanged.

Status: **public HTTPS VERIFIED IN STAGING / SELF-EVALUATED** on 11 October 2026. The owner saved `staging.useraid.fun` → `http://proxy:8080` and Cloudflare created the DNS record. The named VM tunnel is connected, web/worker use the public canonical origin, and `.env` persists `COMPOSE_FILE=compose.yaml:compose-public.yaml`. Public TLS/HTTP/origin-protection and desktop/mobile checks passed; main→GHCR→Watchtower remains operational. The public ingress source/configuration changes are uncommitted; this operational success supplies no independent/full-T005 acceptance.

## Replaceable ingress and host dependencies

Browser HTTPS → Cloudflare edge → authenticated outbound connector → isolated edge bridge → Nginx `proxy:8080` → existing web service. Cloudflare Tunnel requires outbound internet connectivity, including supported TCP/UDP port7844, and a named tunnel/public hostname in the owner's Cloudflare account. No inbound router port forwarding or VM public-IP assumption. Cloudflare manages public TLS; HTTP between connector and proxy is restricted to the dedicated same-host Docker bridge. Existing LAN8443 TLS remains separate.

[Compose overlay](../compose.staging-public.yaml) is applied with [base staging Compose](../compose.staging.yaml). The connector is digest-pinned cloudflared2026.10.0, non-root UID/GID1000, read-only filesystem, no added capabilities, no Docker socket, no published ports, automatic process restart. Its only network is `public_edge` (`172.30.101.0/29`), connector `.3` and proxy `.2`. Database, worker and web stay off that edge network. The proxy also retains the existing application network. Confirm the small subnet does not overlap host/Docker/VPN routes; changing it requires changing both overlay and Nginx trust/listen addresses together and rerunning the contract.

[Public proxy contract](../deploy/staging/nginx-public.conf) listens only on the edge address/port, accepts only the connector peer and exact hostname, trusts Cloudflare's overwritten `CF-Connecting-IP` only from that peer, and overwrites forwarded headers for the app. Untrusted peer403, foreign hostname421. Docker DNS refresh survives web replacement; streaming/websocket forwarding remains supported. Robots headers discourage indexing. No response header supplies product or administrative authority.

The overlay sets runtime `NEXT_PUBLIC_APP_URL=https://staging.useraid.fun` for web and worker. This is required for existing CSRF checks, wallet-signature domain binding and OAuth callbacks. A user action from the old LAN origin will fail origin validation once the public origin is active; public HTTPS becomes the canonical test origin. Do not relax server origin checks to accept arbitrary hosts. Existing staging feature flags remain false. OAuth still needs its own staging provider credentials and registered callback `https://staging.useraid.fun/api/auth/x/callback`; networking alone cannot verify an OAuth login.

## Minimal consuming-host setup

1. In the owner's Cloudflare dashboard, open **Networking → Tunnels** (some dashboard views show Cloudflare One → Networks → Connectors → Cloudflare Tunnels), create `useraid-staging`, and obtain its dedicated **run token**. Save only the token to a local private file; send the agent its path, never its contents. This credential connects that tunnel; it is distinct from the GHCR package token and does not grant general DNS/account administration.
2. Add a published application route: hostname `staging.useraid.fun`, type **HTTP**, service URL **proxy:8080**, path empty. The dashboard creates the tunnel DNS route. Do not point an A record at the private VM IP or change the apex/domain's existing website. Use the exact public Host header; no origin TLS bypass is needed for the private HTTP hop.
3. Copy the overlay to `/home/raidstaging/useraid-staging/compose-public.yaml` and Nginx config to that directory's `nginx-public.conf`. Install the token via SSH stdin at `secrets/cloudflare-tunnel-token`, mode600/owner1000; directory700. On another host, declare matching `STAGING_TUNNEL_UID/GID` for its private file owner. Bind-mounted Compose secrets retain host file permissions.
4. After token installation, add `COMPOSE_FILE=compose.yaml:compose-public.yaml` to this host's `.env` so routine Compose operations continue including the overlay. Configuration/env changes recreate the affected host services; they are not deployed by an image update.

```sh
cd /home/raidstaging/useraid-staging
# Check/render without printing credential or application env values.
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --no-deps web worker proxy cloudflared
docker compose --env-file .env ps
docker compose --env-file .env logs --tail 30 cloudflared
curl --fail --silent --show-error https://staging.useraid.fun/api/health
```

Watchtower continues monitoring only web/worker and preserves the public canonical-origin environment when replacing them. The connector/proxy/database are explicitly excluded. A tunnel token is supplied with `--token-file /run/secrets/cloudflare_tunnel_token`, never as an argument value, Compose environment value, source file or build context. Rotate by replacing the private file and recreating only the connector. Check logs for actual registered tunnel connections. No production data or credentials are added to staging.

## Meaningful contract verification

`python3 -m unittest discover -s tests -p 'test_raid_staging_public.py'` renders the real base/overlay against a synthetic host, then starts a unique synthetic Docker network with real pinned Nginx and a minimal Node echo upstream. It checks valid connector client-IP/HTTPS/host forwarding, a forged forwarded header, foreign-host denial, and direct untrusted-peer denial. Only task-owned fixture containers/network are removed. Declared dependencies: Docker/Compose, image pulls and the unused synthetic subnet `172.30.254.0/29`; Node22 image is pinned, or supply a compatible `STAGING_PROXY_TEST_IMAGE`. No app database, private token, hidden local service or production singleton is consumed.

Genuine RED: missing overlay/proxy config caused one assertion failure and one file-not-found error. GREEN: same two tests passed after implementation. An initial test transport used fetch with a Host override and received421; corrected the synthetic HTTP transport to transmit the intended Host header, preserving200/403/421 assertions. Existing application source is unchanged; no full suite/build result is attributed to changed code. Broader planning/deployment regression, VM checks and live public evidence belong in the task/handoff.

For each consuming host, verify public trusted TLS and `/`, `/privacy`, `/creator`, `/api/health`200, unauthenticated adminAPI401, public-origin logout200 with no session, foreign-origin logout403, desktop/mobile rendering, connector health and unchanged Dokploy/DB/Watchtower identities. Do not claim external access merely from a LAN-IP request. A public Cloudflare request proves the externally routed hostname; representative college/friend-network UAT still belongs to the owner. Preserve the running preview.

## Stop, recovery and remaining gates

Pause public access only with `docker compose --env-file .env stop cloudflared`; local staging/pipeline remain available. Restart that same service to resume. To stop all owned staging after public activation, include both files: `docker compose -p useraid-staging -f /home/raidstaging/useraid-staging/compose.yaml -f /home/raidstaging/useraid-staging/compose-public.yaml --env-file /home/raidstaging/useraid-staging/.env stop`. Preserve volumes and unrelated Dokploy/Traefik services.

If ingress configuration is wrong, correct the owner's one published route and check origin reachability; never expose the database or disable application authentication as a repair. To retire this integration, stop the connector, remove only the staging hostname/tunnel in the owner's account, and explicitly restore the LAN canonical-origin configuration before recreating web/worker/proxy. Existing code rollback/backup/token-expiry/storage duties remain in [the staging runbook](staging-deploy.md).

This host contract can be replaced by another authenticated ingress that preserves origin/client identity and private-network isolation. A tunnel is a reachability mechanism, not a new login/session/financial authority. Independent criterion review, fullT005 acceptance, persistent staging UI indicator, OAuth/provider/financial enablement and production/O18/UAT obligations remain distinct. Cloudflare Access restrictions can be added when the owner identifies permitted testers; this requested preview otherwise exposes the existing public app routes with their normal server permissions.

Primary documentation: [dashboard tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/), [cloudflared release](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0). A temporary [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) has changing hostnames and test-service limits; the owner selected their Cloudflare-managed domain for this stable route.

## Observed VM activation and evidence

On this VM, both application containers retain checked image revision `e492c39ef2c5356a490bb5fdcd31b12beaf4a248` and digest `sha256:a0448967927e2e2559ad2f8ef7f13c431e2daa6c940050aca373012a276c5331`. The public overlay preserves all hazardous feature flags false and `USDC_NETWORK=devnet`. Proxy/connector were created first; after the owner saved DNS, only web/worker were recreated for the canonical origin. Both found22 migrations with none pending; web healthy, worker running, zero restarts. Nine unaffected DB/Watchtower/Dokploy/current-and-historical Swarm identities and start/status/image fields matched the prior capture. Watchtower's12:04:25Z poll scanned2, updated0, failed0.

Public `/`, `/privacy`, `/creator`, `/api/health` returned200 with staging/noindex headers; admin API401. No-session logout with public Origin200; foreign and old LAN Origin403. Chromium desktop1440×1000/mobile390×844 had no page errors or horizontal overflow across all three pages; admin401 on both. Trusted TLS remained enabled. Local macOS cached the earlier nonexistent DNS result, so curl/Chromium mapped the same hostname to the DNS-verified Cloudflare edge IPv4; standard DNS/trusted HTTPS from the VM and two public DNS resolvers passed. The first browser API probe used Node's stale resolver and failed ENOTFOUND; a same-origin browser fetch passed with the same401 assertion.

Durable sanitized evidence is [public staging evidence](../planning/task-evidence/public-staging-20261011/): `public-http.json`, `public-browser.json`, screenshots, `vm-public-verification.json`, migration/Nginx/connector/poll logs and genuine RED/GREEN/regression records. Planning/deployment regression48PASS, final source fingerprint checks PASS. No new application suite/build was attributed to these host-only changes; hosted e492 evidence remains applicable to the unchanged app only. This is a running production-container staging preview, not a separate Next development server. Real OAuth/wallet login, provider operation, payments and representative external-network UAT were not run.

## Git reconciliation and publication preparation

The owner subsequently instructed “Yes check and do it” after the proposed preservation, main reconciliation and separate public-configuration commit. This authorizes the scoped local commit and local main reconciliation; no new push was requested. The public ingress slice is prepared on clean main e492, excludes unfinished wallet-link/test-center implementation, and reuses its recorded operational preview evidence. Historical uncommitted/source statements above describe their observation time. Full T005/independent/UAT acceptance remains NOT VERIFIED.
