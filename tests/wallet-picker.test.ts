import { describe, expect, it } from 'vitest';
import { selectableWallets } from '../src/lib/wallet-picker';

const wallet = (name: string, over: Record<string, unknown> = {}) =>
  ({
    name,
    chains: ['solana:mainnet'],
    features: { 'standard:connect': {}, 'solana:signMessage': {} },
    ...over,
  }) as never;
describe('wallet picker', () => {
  it('lists Solana wallets that can connect and sign messages', () => {
    expect(selectableWallets([wallet('Phantom'), wallet('Solflare')]).map((w) => w.name)).toEqual([
      'Phantom',
      'Solflare',
    ]);
  });
  it('never offers MetaMask, whatever its casing', () => {
    const names = selectableWallets([
      wallet('MetaMask'),
      wallet('metamask'),
      wallet('Phantom'),
    ]).map((w) => w.name);
    expect(names).toEqual(['Phantom']);
  });
  it('drops wallets without Solana mainnet, connect or signMessage support', () => {
    expect(
      selectableWallets([
        wallet('NoChain', { chains: ['ethereum:1'] }),
        wallet('NoSign', { features: { 'standard:connect': {} } }),
        wallet('NoConnect', { features: { 'solana:signMessage': {} } }),
      ]),
    ).toEqual([]);
  });
});
