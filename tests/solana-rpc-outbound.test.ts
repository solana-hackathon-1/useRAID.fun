import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboundFetchError } from '../src/lib/outbound-fetch';
import { solanaConnection } from '../src/lib/solana-rpc';
import { usdcRpc } from '../src/lib/usdc';
import { connection as pumpConnection } from '../src/lib/pump-launch';

/** DEC-2026-11-07-01 (i): Solana RPC gets the same redirect refusal and size limit as every other provider call. */
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const rpcReply = (init: RequestInit, result: unknown) => {
  const { id } = JSON.parse(String(init.body)) as { id: string };
  return Response.json({ jsonrpc: '2.0', id, result });
};
const redirectFailure = () =>
  Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('solanaConnection', () => {
  it('sends every RPC request with redirects refused', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => rpcReply(init, GENESIS));
    vi.stubGlobal('fetch', fetcher);
    await expect(solanaConnection('https://rpc.example/key').getGenesisHash()).resolves.toBe(
      GENESIS,
    );
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://rpc.example/key');
    expect(init.redirect).toBe('error');
  });

  it('refuses a redirecting RPC endpoint instead of following it with the request body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(redirectFailure()));
    const failure = await solanaConnection('https://rpc.example/key')
      .getGenesisHash()
      .catch((error: unknown) => error);
    expect(String(failure)).toContain('Provider redirect refused');
  });

  it('refuses an oversized RPC reply and stops reading it', async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(oversized)));
    const failure = await solanaConnection('https://rpc.example/key')
      .getGenesisHash()
      .catch((error: unknown) => error);
    expect(String(failure)).toContain('Provider response too large');
    expect(cancelled).toBe(true);
  });

  it('keeps HTTP status and body for error replies so web3.js still reports them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('slow down', { status: 500, statusText: 'Oops' })),
    );
    const failure = await solanaConnection('https://rpc.example/key')
      .getGenesisHash()
      .catch((error: unknown) => error);
    expect(String(failure)).toContain('500');
    expect(String(failure)).toContain('slow down');
  });

  it('refuses a plain http endpoint', () => {
    expect(() => solanaConnection('http://rpc.example/key')).toThrow(OutboundFetchError);
  });
});

describe('RPC call sites use the guarded connection', () => {
  it('usdcRpc and the launch connection refuse redirects', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.example/key');
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => rpcReply(init, GENESIS));
    vi.stubGlobal('fetch', fetcher);
    await usdcRpc('mainnet');
    await pumpConnection().getGenesisHash();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(init.redirect).toBe('error');
  });

  it('constructs no Connection outside the guarded helper', () => {
    const root = resolve(__dirname, '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return /\.(ts|tsx)$/.test(name) ? [path] : [];
      });
    const offenders = walk(join(root, 'src'))
      .filter((file) => !file.endsWith('lib/solana-rpc.ts'))
      .filter((file) => /new\s+Connection\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});
