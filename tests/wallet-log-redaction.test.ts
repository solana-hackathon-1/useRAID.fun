// T007 (#49) "No key/secret appears in logs": drives the real wallet challenge and verify routes and
// libraries through their failure paths with an in-memory challenge store, then asserts that nothing
// written to the console contains a signature, signed message, nonce, key material, the raw session
// cookie or the session token generated before the transaction (failure paths only: the success path
// needs the identity lock/session writes and is covered by the DB tests, not by this file).
// Storage and rate limiting are synthetic; the route, validation, signature and origin code are real.
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SESSION_TOKEN = 'SESSION-TOKEN-SENTINEL-7f3a';
const COOKIE_VALUE = 'RAW-COOKIE-SENTINEL-91c2';
const DB_SECRET = 'postgres://wallet_admin:HUNTER2-SENTINEL@db.internal:5432/useraid';

type Row = {
  digest: string;
  address: string;
  message: string;
  userId: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
};
const mocks = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  create: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  user: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: 'RAW-COOKIE-SENTINEL-91c2' }) }),
}));
vi.mock('../src/lib/db', () => ({ db: { walletChallenge: { create: mocks.create } } }));
vi.mock('../src/lib/command-receipts-adapter', () => ({
  runCommandTransaction: async (_db: unknown, work: (port: unknown, tx: unknown) => unknown) =>
    work(undefined, {
      walletIdentity: { findUnique: async () => null },
      walletLink: { findUnique: async () => null },
      walletChallenge: { findUnique: mocks.findUnique, updateMany: mocks.updateMany },
    }),
}));
vi.mock('../src/lib/usdc', () => ({ lockBalance: async () => undefined }));
vi.mock('../src/lib/auth-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth-primitives')>()),
  random: () => 'SESSION-TOKEN-SENTINEL-7f3a',
}));
vi.mock('../src/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth')>()),
  publicRateLimit: vi.fn(),
  currentUser: () => mocks.user(),
}));
import { config } from '../src/lib/config';
import { POST as challengeRoute } from '../src/app/api/wallet/challenge/route';
import { POST as verifyRoute } from '../src/app/api/wallet/verify/route';
import { routeRequest } from './helpers/route';

const ORIGIN = 'http://localhost:3000';
const keys = nacl.sign.keyPair();
const other = nacl.sign.keyPair();
const address = bs58.encode(keys.publicKey);
const sign = (message: string, pair = keys) =>
  bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), pair.secretKey));

const logs: string[] = [];
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
const post = (
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  origin: string | undefined = ORIGIN,
) => handler(routeRequest('http://localhost/api/wallet/x', { method: 'POST', body, origin }));

let issued: Row;
let secrets: string[];
async function issueChallenge() {
  const res = await post(challengeRoute, { address });
  expect(res.status).toBe(200);
  issued = mocks.rows.get((await res.json()).digest) as Row;
  const nonce = /Nonce: (\S+)/.exec(issued.message)?.[1] ?? '';
  expect(nonce).not.toBe('');
  secrets = [
    issued.message,
    nonce,
    sign(issued.message),
    bs58.encode(keys.secretKey),
    Buffer.from(keys.secretKey).toString('hex'),
    Buffer.from(keys.secretKey).toString('base64'),
    SESSION_TOKEN,
    COOKIE_VALUE,
    DB_SECRET,
    'HUNTER2-SENTINEL',
  ];
}
function expectClean(...responses: string[]) {
  for (const secret of secrets) {
    expect(logs.join('\n'), `console leaked ${secret.slice(0, 24)}`).not.toContain(secret);
    for (const body of responses) expect(body).not.toContain(secret);
  }
}
const verify = (signature: string, extra: Record<string, unknown> = {}, o?: string) =>
  post(verifyRoute, { digest: issued.digest, address, signature, ...extra }, o);

beforeEach(() => {
  vi.stubEnv('USDC_NETWORK', 'devnet');
  logs.length = 0;
  for (const method of consoleMethods)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (a instanceof Error ? `${a.stack}` : String(a))).join(' '));
    });
  mocks.rows.clear();
  mocks.user.mockReset().mockResolvedValue(null);
  mocks.create.mockReset().mockImplementation(async ({ data }: { data: Row }) => {
    mocks.rows.set(data.digest, { ...data, consumedAt: null });
  });
  mocks.findUnique
    .mockReset()
    .mockImplementation(async ({ where }) => mocks.rows.get(where.digest));
  mocks.updateMany.mockReset().mockResolvedValue({ count: 1 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  config.appUrl = ORIGIN;
});

describe('wallet failure paths never log signatures, messages, nonces, session tokens or keys', () => {
  it('rejects a bad signature (401)', async () => {
    await issueChallenge();
    const forged = sign(issued.message, other);
    secrets.push(forged);
    const res = await verify(forged);
    expect(res.status).toBe(401);
    expectClean(await res.text());
  });
  it('rejects a replayed (already consumed) challenge (401)', async () => {
    await issueChallenge();
    issued.consumedAt = new Date();
    const res = await verify(sign(issued.message));
    expect(res.status).toBe(401);
    expectClean(await res.text());
  });
  it('rejects a challenge that lost the consume race (409)', async () => {
    await issueChallenge();
    mocks.updateMany.mockResolvedValue({ count: 0 });
    const res = await verify(sign(issued.message));
    expect(res.status).toBe(409);
    expectClean(await res.text());
  });
  it('rejects a stale challenge (401)', async () => {
    await issueChallenge();
    issued.expiresAt = new Date(Date.now() - 1000);
    const res = await verify(sign(issued.message));
    expect(res.status).toBe(401);
    expectClean(await res.text());
  });
  it('rejects a request from the wrong origin (403) and a challenge for another domain (401)', async () => {
    await issueChallenge();
    const wrongHeader = await verify(sign(issued.message), {}, 'https://evil.example');
    expect(wrongHeader.status).toBe(403);
    config.appUrl = 'https://other.example';
    const wrongDomain = await verify(sign(issued.message), {}, 'https://other.example');
    expect(wrongDomain.status).toBe(401);
    expectClean(await wrongHeader.text(), await wrongDomain.text());
  });
  it('rejects malformed signature and a wrong-purpose (rotate) proof without logging them', async () => {
    await issueChallenge();
    const malformed = await verify('not-base58-0OIl');
    expect(malformed.status).toBe(400);
    mocks.user.mockResolvedValue({ id: 'u1' });
    const rotate = await verify(sign(issued.message), { rotate: true });
    expect(rotate.status).toBe(401);
    expectClean(await malformed.text(), await rotate.text());
  });
  it('sanitizes a storage error carrying a secret inside the verify transaction (503)', async () => {
    await issueChallenge();
    mocks.findUnique.mockRejectedValue(new Error(`connect failed ${DB_SECRET} ${issued.message}`));
    const res = await verify(sign(issued.message));
    expect(res.status).toBe(503);
    expectClean(await res.text());
  });
  it('sanitizes a storage error carrying a secret when issuing a challenge (503), keeping an operator signal', async () => {
    mocks.create.mockRejectedValue(new Error(`insert failed for ${DB_SECRET}`));
    const res = await post(challengeRoute, { address });
    expect(res.status).toBe(503);
    const { message } = mocks.create.mock.calls[0][0].data as Row;
    secrets = [
      DB_SECRET,
      'HUNTER2-SENTINEL',
      message,
      /Nonce: (\S+)/.exec(message)?.[1] ?? 'missing-nonce',
    ];
    expect(logs.join('\n')).toContain('wallet challenge store failed STORAGE_UNAVAILABLE');
    expectClean(await res.text());
  });
  it('positive control: the console spies capture the code and class failure() logs for an unknown error, not its message', async () => {
    await issueChallenge();
    mocks.user.mockRejectedValue(new Error('control-line-sentinel'));
    const res = await verify(sign(issued.message));
    expect(res.status).toBe(503);
    expect(logs.join('\n')).toContain('"event":"request-failed"');
    expect(logs.join('\n')).toContain('"code":"UNCLASSIFIED"');
    expect(logs.join('\n')).not.toContain('control-line-sentinel');
  });
});
