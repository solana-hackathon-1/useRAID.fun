'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { StandardConnectFeature } from '@wallet-standard/features';
import type { SolanaSignMessageFeature } from '@solana/wallet-standard-features';
import bs58 from 'bs58';
const rejected = (e: unknown) =>
  e instanceof Error && (e.name === 'WalletSignMessageError' || /reject/i.test(e.message));
export function WalletLogin({
  currentAddress,
  canChange = false,
}: {
  currentAddress: string | null;
  canChange?: boolean;
}) {
  const router = useRouter();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
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
    const rotate = !!currentAddress;
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
      const challenge = await post('/api/wallet/challenge', {
        address: account.address,
        ...(rotate ? { rotate } : {}),
      });
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
        ...(rotate ? { rotate } : {}),
      });
      setChanging(false);
      router.refresh();
    } catch (e) {
      setError(
        rejected(e)
          ? 'Request cancelled in wallet. Choose a wallet to try again.'
          : e instanceof Error
            ? e.message
            : 'Wallet failed.',
      );
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
      {(!currentAddress || changing) && (
        <div className="wallet-options" role="group" aria-label="Solana wallets">
          {wallets.map((w) => (
            <button
              key={w.name}
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => void connect(w)}
            >
              {w.icon && <img src={w.icon} alt="" width={16} height={16} />}
              Connect {w.name}
            </button>
          ))}
        </div>
      )}
      {canChange && currentAddress && !changing && (
        <button className="button secondary" onClick={() => setChanging(true)}>
          Change wallet
        </button>
      )}
      {changing && (
        <>
          <p className="small-print">
            The new wallet replaces this one for sign-in, enrollments and payouts. You can change it
            once every 7 days, only with no pending deposits or withdrawals, and withdrawals pause
            for 24 hours afterwards. Raids you already joined keep paying the wallet you joined
            with.
          </p>
          <button className="button secondary" disabled={busy} onClick={() => setChanging(false)}>
            Cancel
          </button>
        </>
      )}
      {(!currentAddress || changing) && !wallets.length && (
        <p className="small-print">
          Open this page in a browser with a Solana wallet extension. Wallet extensions require
          HTTPS or localhost.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
