# Meteora launch setup — isolated devnet pilot

Project: `/Users/0xd/Documents/useRAID.fun`. Run every command below from this directory. Start with devnet. Mainnet approval remains off until a funded, end-to-end lifecycle passes.

## Current state

Launch wizard, native trading, per-launch fee routing, automatic campaign drafts, migration/reserve handling, reviewed payouts and Operations controls are implemented. Production build and 78 unit tests pass; four isolated database tests pass. These checks do not prove funded Solana transactions or real X impression access.

Local PostgreSQL and isolated `useraid_meteora_devnet` database are already created and migrated. RPC, Pinata JWT, launch encryption key and operator public/private keys remain unconfigured at the time this guide was written. Launch switch is off; X collection is off.

## 1. Configuration files

| Location                                      | Purpose                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env.local`                                  | Shared server settings: devnet RPC, Pinata JWT, encryption key, operator public address, X credentials and feature switches. Next web service and Meteora runner read this file. |
| `.env.meteora.worker`                         | Operator private key only. `meteora:worker` and `meteora:doctor` load this file; the Meteora web runner does not.                                                                |
| `.env`                                        | Existing base configuration, including local PostgreSQL connection. Keep its existing values.                                                                                    |
| `.env.example`, `.env.meteora.worker.example` | Blank references; do not replace existing configuration wholesale.                                                                                                               |

Real environment files are Git-ignored. Never use `NEXT_PUBLIC_` for credentials. Keep operator private key out of web deployment. Encryption key must be available to both web and worker: it encrypts/decrypts per-launch signing keys. Back up encryption keys securely alongside encrypted database backups; losing a key prevents the worker from recovering its associated campaign wallets.

## 2. Solana devnet RPC

Use a provider's HTTPS **devnet** Solana RPC endpoint. For example, create a Helius project/API key and copy its devnet endpoint from the dashboard. Use a provider that supports finalized account reads, transaction submission, simulation, signatures/history and transaction metadata. Historical receipts are required to verify migration and reserve claims; retain sufficient history for your launches. See [Helius getting started](https://www.helius.dev/docs/getting-data/quickstart).

Put the endpoint in `.env.local`:

```dotenv
METEORA_RPC_URL=https://YOUR_DEVNET_RPC_ENDPOINT
```

The endpoint must start with `https://`. Runtime checks verify the genesis hash and reject mainnet endpoints in this devnet pilot. No separate Meteora account or Meteora API key is needed by this implementation: SDKs call Solana programs through this RPC.

## 3. Pinata image and metadata storage

Create a Pinata account. Dashboard → API Keys → New Key → name the key → grant upload permissions → Create Key. Save the **JWT**, not the API key or API secret. JWT is shown only when the key is created. See [Pinata API keys](https://docs.pinata.cloud/account-management/api-keys).

The integration uploads token logos and JSON metadata to **public IPFS** through `POST https://uploads.pinata.cloud/v3/files`, so the JWT must allow that endpoint. Do not configure expiring uploads for permanent token metadata. See [Pinata public uploads](https://docs.pinata.cloud/files/uploading-files).

```dotenv
PINATA_JWT=YOUR_PINATA_JWT
```

No Pinata gateway variable is currently required.

## 4. Dedicated operator wallet

Two wallets have different jobs:

- Creator/browser wallet signs launch, buys/sells and creator fee claims. Its private key stays in the wallet.
- Operator wallet is a dedicated server signer. It pays worker network/rent costs for collection, graduation and reviewed payouts. Do not use a personal wallet that holds mainnet assets.

To generate a fresh operator without printing its private key, run this once from the project directory. It deliberately refuses to overwrite an existing worker file:

```sh
node --input-type=module <<'NODE'
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { writeFileSync } from 'node:fs';
const wallet = Keypair.generate();
writeFileSync('.env.meteora.worker',
  `METEORA_OPERATOR_SECRET_KEY=${bs58.encode(wallet.secretKey)}\n`,
  { flag: 'wx', mode: 0o600 });
console.log(`METEORA_OPERATOR_PUBLIC_KEY=${wallet.publicKey.toBase58()}`);
NODE
```

Copy the printed **public** setting into `.env.local`:

```dotenv
METEORA_OPERATOR_PUBLIC_KEY=YOUR_OPERATOR_PUBLIC_ADDRESS
```

If using an existing dedicated operator, create `.env.meteora.worker` manually from the example. Set `METEORA_OPERATOR_SECRET_KEY` to the base58 encoding of the complete **64-byte Solana keypair**, not a seed phrase, 32-byte seed, public address or JSON array. Its public address must match `.env.local` exactly. Do not paste either private keys or seed phrases into chat.

Fund both wallets using the [Solana devnet faucet](https://faucet.solana.com/). Worker requires at least **0.05 devnet SOL** to operate; 1–2 devnet SOL gives more testing room. Creator also needs devnet SOL for launch account creation, fees and test buys. Graduation threshold is **1 SOL**, so keep enough test funds available for that lifecycle and top up as needed. These amounts are testing guidance, not a quoted launch cost. Actual launch transactions show estimated network/account costs before signature.

## 5. Launch encryption key

Generate 32 random bytes, base64 encoded:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy that output locally into `.env.local`; it is a secret, so do not send it in chat:

```dotenv
LAUNCH_KEY_VERSION=1
LAUNCH_KEY_1=YOUR_GENERATED_BASE64_KEY
```

If `LAUNCH_KEY_1` already exists and was used for launches, keep it. When rotating, add a new version and preserve old `LAUNCH_KEY_N` values while associated encrypted wallets still exist. Never regenerate an existing key as a repair step.

## 6. Initial switches

Merge these entries into `.env.local`, preserving existing X credentials and database settings:

```dotenv
METEORA_NETWORK=devnet
METEORA_DEVNET_APP_URL=http://localhost:3008
METEORA_LAUNCH_ENABLED=true
METEORA_TRADING_ENABLED=true
METEORA_COLLECTION_ENABLED=true
METEORA_PAYOUT_ENABLED=false
METEORA_MAINNET_APPROVED=false
METEORA_DEVNET_ACCEPTED=false
```

`METEORA_COLLECTION_ENABLED` controls on-chain fee collection and migration, not X data collection. Keep new payout transfers disabled until X tracking and review are validated. Legacy `LAUNCH_ENABLED` and `PAYOUT_ENABLED` are separate Pump settings; leave them off.

Meteora runner forces devnet, non-demo mode, separate session cookie/database, port 3008 and `.next-meteora` build directory. Do not change the original base `DATABASE_URL` just to run this pilot: runner automatically selects `useraid_meteora_devnet`. Existing application at port 3000 uses its original database.

## 7. Start services and validate

Node 22.12+ and Docker/PostgreSQL are needed; dependencies are already installed in this checkout.

```sh
cd /Users/0xd/Documents/useRAID.fun
docker compose up -d db
npm run meteora:migrate
npm run meteora:doctor
```

Doctor checks missing settings, signer/public-key match, RPC network, Meteora program deployment, migration config, operator SOL and database access without printing credentials. It does not prove that the Pinata JWT can upload or that X can provide impressions.

Terminal A:

```sh
npm run meteora:dev
```

Terminal B:

```sh
npm run meteora:worker
```

Open `http://localhost:3008/launch`. Set browser wallet to devnet, connect, upload token image, enter name/ticker, review economics and sign the three setup transactions. Resume the same launch if interrupted. Successful launch creates a token page and campaign draft automatically. Worker must stay running for fee collection, migration, reserve claims and payments; web server alone cannot perform those jobs.

Restart both processes after environment changes. Use `localhost`, not `127.0.0.1`, in browser links and X callback configuration so origins match.

## 8. X connection, tracking and Operations

Existing X settings can be kept. Verify the new devnet callback in your X app before using campaigns:

1. X Developer Console → project/app → authentication settings. Enable OAuth 2.0 for a confidential web application with Client ID and Client Secret.
2. Add exact callback: `http://localhost:3008/api/auth/x/callback`. Website/origin: `http://localhost:3008`. Keep any existing callback for your other application environment.
3. Put `X_CLIENT_ID` and `X_CLIENT_SECRET` in `.env.local`. This implementation requests `tweet.read users.read` scopes. Sharing opens a user-controlled X composer; it does not require automatic posting permission. See [X OAuth 2.0 setup](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code).
4. Configure `X_BEARER_TOKEN` separately for server reads. Verify app access to recent search, tweet lookup and usable `public_metrics.impression_count` for the qualified posts you intend to pay. Missing impressions must not be treated as zero or guessed from likes.
5. Set `ADMIN_X_IDS` to your immutable numeric X user ID, not `@handle`, then sign in/reconnect X. `X_ADMIN_USER_ID` also supports one admin. Operations is at `http://localhost:3008/admin`.
6. In Operations → Operating limits, set an explicit X request/spend budget and enable X collection. Check X diagnostics with your connected account. Provider access, quotas and prices must be checked for your account; Solana devnet does not make X requests free.
7. After X feasibility/review validation, set `LIVE_COLLECTION_APPROVED=true`, `X_TRACKING_V2_ENABLED=true`, `X_TRACKING_V2_SETTLEMENT_ENABLED=true`, `METEORA_PAYOUT_ENABLED=true`; restart web and worker.
8. In Meteora launch operations, ensure launches/payouts are allowed and worker is ready. Each resulting payout still needs Operations approval; enabling the switch alone does not approve allocations.

Campaign start requires a connected X account, fresh healthy worker, tracking/settlement gates, collection enabled, payouts enabled/unpaused and sufficient unreserved campaign funds. Devnet minimum campaign budget is **0.01 SOL**. Token rewards remain a separate optional budget and become available only after verified graduation/reserve withdrawal. With a 20% share of distributable 1% trading fees, reaching 0.01 SOL of campaign revenue can require meaningful trading volume; launching alone does not fund it.

## 9. Economics already configured

No manual mint, pool config, fee-sharing vault or campaign wallet address is required; those are created per launch.

| Setting                               | Devnet template                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| Fixed supply / decimals               | 1 billion / 6                                                                           |
| Quote asset                           | SOL                                                                                     |
| Trading fee before / after graduation | 1% / 1%; dynamic fees off                                                               |
| Graduation                            | 1 SOL devnet; planned 10 SOL mainnet                                                    |
| Token allocation                      | 20% supply for migration liquidity; nominal 5% campaign reserve                         |
| Distributable revenue                 | 80% creator, 20% campaign, 0% useRAID                                                   |
| LP ownership                          | Entire fee-producing partner position permanently locked, controlled by fee-sharing PDA |
| Authority rules                       | No future minting, no freeze authority, immutable metadata                              |

Meteora protocol fees are separate; 80/20 applies to distributable revenue, not every trader-paid lamport. SDK rounding produces a small reserve remainder above nominal 50 million tokens; public configuration snapshot records exact integer amounts and supply conservation. Allocation changes require a new launch template/configuration; existing launches keep signed economics. Current UI intentionally uses one canonical template rather than dynamic sliders.

## Integration with the hardened release

Meteora runs on the same rails as the other funded Raids, so these rules apply to it too:

- **Gates.** `launchpadsAvailable` (`src/lib/release.ts`) stays `false` and only gates the legacy Pump launchpad. Meteora is controlled by `METEORA_LAUNCH_ENABLED` and its readiness checks. While both are off, `/launch` shows the Coming soon card. The launch API routes (`prepare`, `upload`, `[id]/retry`, `[id]/submit`) serve Meteora launches only; Pump requests still receive 503.
- **Image proofs.** Upload proofs are signed with `LAUNCH_ASSET_KEY` (web only, 32 random bytes, base64), not with the launch encryption key. Readiness stays off until it is set. The worker ignores this setting.
- **Settlement.** Fee-funded campaigns settle only while `X_TRACKING_V2_SETTLEMENT_ENABLED=true`; while it is off, allocation pauses and the reservation stays in place.
- **Author cap and minimum.** The per-author cap (`RAID_AUTHOR_CAP_BPS`, default 25%) is frozen on the Raid when the campaign starts and applies to the SOL and token budgets. SOL rewards below `SOL_MIN_PAYOUT_LAMPORTS` are not paid and return to the campaign balance.
- **State vocabularies.** Campaign Raids use `fundingAsset = 'LAUNCH'`, which `src/lib/states.ts` and the `Raid_fundingAsset_check` constraint allow.
- **Worker.** Meteora jobs (`meteora-reconcile`, `meteora-finance`) and LAUNCH settlement run from `src/lib/worker-jobs.ts` as isolated steps with the usual dead-lettering.
- **Admin and public routes.** Payout decisions need an X-signed administrator session and a same-origin request. Public read endpoints are rate limited. Request bodies are parsed with `readJson`.
- **Migrations.** The three Meteora migrations keep their `202610020001`-`202610020003` names. The hardening migrations follow as `202610030001`-`202610030012`.
- **Content security policy.** The wizard previews the chosen logo from a `data:` URL, so `img-src` needs no `blob:`. Wallet signing happens in the browser extension and all RPC calls stay on the server, so `connect-src` stays `'self'`.

## 10. Mainnet prerequisites

Mainnet is not ready merely because setup checks pass. Complete launch → trade → collect → SOL campaign → review/dispute → approved payout → graduation → locked-LP fee claims → token reserve → token payout, including retry/rounding/zero-view cases. Then configure production RPC/history, production database, HTTPS origin/X callback, secure shared encryption keys, worker-only signer, database/key backups, monitoring and an always-running worker.

Mainnet also requires explicit `METEORA_DEVNET_ACCEPTED=true`, `METEORA_MAINNET_APPROVED=true` and positive approved limits for `METEORA_MAX_CUSTODY_SOL`, `METEORA_MAX_PAYOUT_SOL`, `METEORA_MAX_PAYOUT_TOKENS`. Do not enable these flags now. Local `meteora:*` commands intentionally force devnet; production deployment must set its own network and service environment. Deploy neither local environment files nor devnet wallets as production configuration.
