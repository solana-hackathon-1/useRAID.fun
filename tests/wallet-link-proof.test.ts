import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { IdentityLinkError } from '../src/identity-link';
import {
  LINK_ADDITIONAL_STATEMENT,
  SIWS_CHAIN_ID,
  deriveWalletLinkProof,
} from '../src/lib/wallet-link-proof';
import { LinkProofObservationSchema } from '../src/identity';
import { fixtureAddress } from './helpers/wallet-link-fixtures';

const ADDRESS = fixtureAddress(2);
const ISSUED = '2026-10-09T08:59:00.000Z';
const EXPIRES = '2026-10-09T09:04:00.000Z';
function message(overrides: Partial<Record<string, string>> = {}) {
  const f = {
    host: 'localhost:3000',
    address: ADDRESS,
    statement: LINK_ADDITIONAL_STATEMENT,
    uri: 'http://localhost:3000',
    chain: SIWS_CHAIN_ID,
    nonce: 'nonce-synthetic-0123456789',
    issued: ISSUED,
    expires: EXPIRES,
    ...overrides,
  };
  // Same canonical text the legacy generator produces (src/lib/wallet-auth.ts createWalletChallenge).
  return `${f.host} wants you to sign in with your Solana account:\n${f.address}\n\n${f.statement}\n\nURI: ${f.uri}\nVersion: 1\nChain ID: ${f.chain}\nNonce: ${f.nonce}\nIssued At: ${f.issued}\nExpiration Time: ${f.expires}`;
}
function row(text = message(), overrides: Record<string, unknown> = {}) {
  return {
    digest: createHash('sha256').update(text).digest('hex'),
    address: ADDRESS,
    message: text,
    userId: 'account-alice' as string | null,
    expiresAt: new Date(EXPIRES),
    consumedAt: null as Date | null,
    ...overrides,
  };
}
const opts = { signatureVerified: true };
const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof IdentityLinkError ? error.code : `OTHER:${error}`;
  }
  return 'NO_ERROR';
};

describe('wallet-link proof adapter (WR11)', () => {
  it('derives every field strictly from the stored message and column', () => {
    const proof = deriveWalletLinkProof(row(), opts);
    expect(LinkProofObservationSchema.safeParse(proof).success).toBe(true);
    expect(proof).toEqual({
      ref: row().digest,
      state: 'VERIFIED',
      accountId: 'account-alice',
      intent: 'LINK',
      subject: { kind: 'WALLET', networkIdentity: 'mainnet', address: ADDRESS },
      domain: 'localhost:3000',
      uri: 'http://localhost:3000',
      issuedAt: ISSUED,
      expiresAt: EXPIRES,
      consumed: false,
    });
  });

  it('uses the same chain constant the generator signs and never defaults issuedAt to now', () => {
    expect(SIWS_CHAIN_ID).toBe('mainnet');
    const other = message({ chain: 'devnet' });
    expect(deriveWalletLinkProof(row(other), opts).subject).toMatchObject({
      networkIdentity: 'devnet',
    });
    const withoutIssued = message().replace(/\nIssued At: .*\n/, '\n');
    expect(invalid(() => deriveWalletLinkProof(row(withoutIssued), opts))).toBe('PROOF_INVALID');
  });

  it('marks the observation unverified when the host did not verify the signature', () => {
    expect(deriveWalletLinkProof(row(), { signatureVerified: false }).state).toBe('UNVERIFIED');
  });

  const broken: [string, () => ReturnType<typeof row>][] = [
    [
      'wrong statement',
      () => row(message({ statement: 'Link this wallet to your useRAID.fun account.' })),
    ],
    ['address line differs from row address', () => row(message({ address: fixtureAddress(3) }))],
    ['digest is not the hash of the message', () => row(message(), { digest: 'f'.repeat(64) })],
    [
      'expiration differs from the column',
      () => row(message(), { expiresAt: new Date('2026-10-09T09:05:00.000Z') }),
    ],
    ['issued after expiry', () => row(message({ issued: '2026-10-09T09:10:00.000Z' }))],
    ['non-ISO issuedAt', () => row(message({ issued: 'yesterday' }))],
    ['row for an anonymous sign-in challenge', () => row(message(), { userId: null })],
    ['already consumed row', () => row(message(), { consumedAt: new Date() })],
    ['extra trailing line', () => row(`${message()}\nResources: x`)],
    ['missing line', () => row(message().replace('Version: 1\n', ''))],
    [
      'reordered lines',
      () =>
        row(message().replace('Version: 1\nChain ID: mainnet', 'Chain ID: mainnet\nVersion: 1')),
    ],
    ['wrong version', () => row(message().replace('Version: 1', 'Version: 2'))],
    [
      'uri with path smuggling newline',
      () => row(message({ uri: 'http://localhost:3000\nNonce: x' })),
    ],
    ['empty host', () => row(message({ host: '' }))],
    ['chain id with spaces', () => row(message({ chain: 'main net' }))],
  ];
  it.each(broken)('%s is PROOF_INVALID', (_name, make) => {
    expect(invalid(() => deriveWalletLinkProof(make(), opts))).toBe('PROOF_INVALID');
  });

  it('accepts an expected legacy statement only when the caller names it', () => {
    const legacy = 'Link this wallet to your useRAID.fun account.';
    const text = message({ statement: legacy });
    expect(invalid(() => deriveWalletLinkProof(row(text), opts))).toBe('PROOF_INVALID');
    expect(deriveWalletLinkProof(row(text), { ...opts, expectedStatement: legacy }).intent).toBe(
      'LINK',
    );
  });
});
