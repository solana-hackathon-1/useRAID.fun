import { afterEach, describe, expect, it, vi } from 'vitest';
import { usdcRpc } from '../src/lib/usdc';

/** The devnet payment path must accept the real, full devnet genesis hash and nothing else. */
const DEVNET = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const reply = (genesis: string) =>
  vi.fn(async (_url: string, init: RequestInit) => {
    const { id } = JSON.parse(String(init.body)) as { id: string };
    return Response.json({ jsonrpc: '2.0', id, result: genesis });
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('usdcRpc devnet genesis', () => {
  it('accepts the full devnet genesis hash', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.example/key');
    vi.stubGlobal('fetch', reply(DEVNET));
    await expect(usdcRpc('devnet')).resolves.toBeDefined();
  });
  it('refuses a truncated devnet hash, mainnet on the devnet path and devnet on the mainnet path', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.example/key');
    for (const [network, genesis] of [
      ['devnet', DEVNET.slice(0, 32)],
      ['devnet', MAINNET],
      ['mainnet', DEVNET],
    ] as const) {
      vi.stubGlobal('fetch', reply(genesis));
      await expect(usdcRpc(network)).rejects.toThrow(/network does not match/i);
    }
  });
});
