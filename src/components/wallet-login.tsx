'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { StandardConnectFeature } from '@wallet-standard/features';
import type { SolanaSignMessageFeature } from '@solana/wallet-standard-features';
import bs58 from 'bs58';
export function WalletLogin({ currentAddress }: { currentAddress: string | null }) {
  const router = useRouter();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const api = getWallets();
    const refresh = () =>
      setWallets(
        api
          .get()
          .filter(
            (w) =>
              w.chains.includes('solana:mainnet') &&
              'standard:connect' in w.features &&
              'solana:signMessage' in w.features,
          ),
      );
    refresh();
    const offA = api.on('register', refresh),
      offB = api.on('unregister', refresh);
    return () => {
      offA();
      offB();
    };
  }, []);
  async function post(path: string, value: unknown) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Wallet verification failed.');
    return result;
  }
  async function connect(wallet: Wallet) {
    setBusy(true);
    setError('');
    try {
      const { accounts } = await (wallet.features as StandardConnectFeature)[
        'standard:connect'
      ].connect();
      const account: WalletAccount | undefined = accounts.find((a) =>
        a.chains.includes('solana:mainnet'),
      );
      if (!account) throw new Error('No Solana mainnet account.');
      const challenge = await post('/api/wallet/challenge', { address: account.address });
      const signed = (
        await (wallet.features as SolanaSignMessageFeature)['solana:signMessage'].signMessage({
          account,
          message: new TextEncoder().encode(challenge.message),
        })
      )[0];
      if (new TextDecoder().decode(signed.signedMessage) !== challenge.message)
        throw new Error('Wallet changed sign-in message.');
      await post('/api/wallet/verify', {
        digest: challenge.digest,
        address: account.address,
        signature: bs58.encode(signed.signature),
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wallet failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="wallet-login">
      <p>
        {currentAddress
          ? `Verified wallet: ${currentAddress}`
          : 'Verify your Solana wallet to join Raids.'}
      </p>
      {!currentAddress && (
        <select
          aria-label="Select Solana wallet"
          disabled={busy}
          defaultValue=""
          onChange={(e) => {
            const wallet = wallets.find((w) => w.name === e.target.value);
            if (wallet) void connect(wallet);
          }}
        >
          <option value="">Select wallet</option>
          {wallets.map((w) => (
            <option key={w.name}>{w.name}</option>
          ))}
        </select>
      )}
      {!currentAddress && !wallets.length && <p className="small-print">Open this page in a browser with a Solana wallet extension. Wallet extensions require HTTPS or localhost.</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
