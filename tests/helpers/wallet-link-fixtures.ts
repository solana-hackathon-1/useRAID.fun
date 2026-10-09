// Synthetic, test-only fixtures for the wallet-link slice. Never real accounts or wallets.
import bs58 from 'bs58';

export const FIXTURE_NOW = '2026-10-09T09:00:00.000Z';
export const FIXTURE_DOMAIN = 'localhost:3000';
export const FIXTURE_URI = 'http://localhost:3000';
export const FIXTURE_NETWORK = 'mainnet';
export const FIXTURE_LIMITS = { maxActiveLinks: 5, maxTotalLinks: 20 } as const;

/** Deterministic canonical 32-byte base58 address, distinct per seed (1..255). */
export function fixtureAddress(seed: number): string {
  return bs58.encode(new Uint8Array(32).fill(seed));
}

export function fixturePolicy() {
  return {
    domain: FIXTURE_DOMAIN,
    uri: FIXTURE_URI,
    walletNetworks: [FIXTURE_NETWORK],
    providers: [],
  } as const;
}

export function fixtureSession(accountId: string, overrides: Record<string, unknown> = {}) {
  return { accountId, state: 'ACTIVE', expiresAt: '2026-10-16T09:00:00.000Z', ...overrides };
}

export function fixtureProof(
  accountId: string,
  address: string,
  ref: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ref,
    state: 'VERIFIED',
    accountId,
    intent: 'LINK',
    subject: { kind: 'WALLET', networkIdentity: FIXTURE_NETWORK, address },
    domain: FIXTURE_DOMAIN,
    uri: FIXTURE_URI,
    issuedAt: '2026-10-09T08:59:00.000Z',
    expiresAt: '2026-10-09T09:04:00.000Z',
    consumed: false,
    ...overrides,
  };
}

/** Complete valid `linkVerifiedWallet` input; override any field per case. */
export function fixtureLinkInput(
  accountId: string,
  address: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    accountId,
    actorAccountId: accountId,
    requestId: 'request-link-1',
    subject: { networkIdentity: FIXTURE_NETWORK, address },
    proof: fixtureProof(accountId, address, `proof-${address}`),
    session: fixtureSession(accountId),
    policy: fixturePolicy(),
    now: FIXTURE_NOW,
    limits: FIXTURE_LIMITS,
    ...overrides,
  };
}
