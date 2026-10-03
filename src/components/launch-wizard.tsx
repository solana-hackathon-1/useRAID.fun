'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { StandardConnectFeature } from '@wallet-standard/features';
import type {
  SolanaSignMessageFeature,
  SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import bs58 from 'bs58';

type Compatible = Wallet &
  StandardConnectFeature &
  SolanaSignMessageFeature &
  SolanaSignTransactionFeature;
function isCompatible(wallet: Wallet): wallet is Compatible {
  return (
    'standard:connect' in wallet.features &&
    'solana:signMessage' in wallet.features &&
    'solana:signTransaction' in wallet.features &&
    wallet.chains.includes('solana:mainnet')
  );
}
async function json(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const decode = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
export function LaunchWizard({
  sessionWallet,
  enabled,
  recoveries,
}: {
  sessionWallet: string | null;
  enabled: boolean;
  recoveries: { id: string; name: string; symbol: string; status: string }[];
}) {
  const router = useRouter();
  const [wallets, setWallets] = useState<Compatible[]>([]);
  const [selected, setSelected] = useState<{ wallet: Compatible; account: WalletAccount } | null>(
    null,
  );
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    name: '',
    symbol: '',
    description: '',
    website: '',
    x: '',
    telegram: '',
    discord: '',
  });
  const [logo, setLogo] = useState<File | null>(null);
  const [banner, setBanner] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<{
    id: string;
    mint: string;
    feeAddress: string;
    transaction: string;
    estimatedLamports: number;
    rewardMode: 'reviewed' | 'hourly';
    settlementEnabled: boolean;
  } | null>(null);
  const [live, setLive] = useState<{
    mint: string;
    raidId: string | null;
    signature: string | null;
  } | null>(null);
  useEffect(() => {
    const api = getWallets();
    const refresh = () => setWallets(api.get().filter(isCompatible));
    refresh();
    const offA = api.on('register', refresh),
      offB = api.on('unregister', refresh);
    return () => {
      offA();
      offB();
    };
  }, []);
  async function connect(wallet: Compatible) {
    setBusy(true);
    setError('');
    try {
      const { accounts } = await (wallet.features as StandardConnectFeature)[
        'standard:connect'
      ].connect();
      const account = accounts.find((a) => a.chains.includes('solana:mainnet'));
      if (!account) throw new Error('Wallet has no Solana mainnet account.');
      const challenge = await json('/api/wallet/challenge', { address: account.address });
      const signed = (
        await (wallet.features as SolanaSignMessageFeature)['solana:signMessage'].signMessage({
          account,
          message: new TextEncoder().encode(challenge.message),
        })
      )[0];
      if (new TextDecoder().decode(signed.signedMessage) !== challenge.message)
        throw new Error('Wallet changed sign-in message.');
      await json('/api/wallet/verify', {
        digest: challenge.digest,
        address: account.address,
        signature: bs58.encode(signed.signature),
      });
      setSelected({ wallet, account });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wallet connection failed.');
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File, kind: 'logo' | 'banner') {
    const data = new FormData();
    data.append('kind', kind);
    data.append('file', file);
    const response = await fetch('/api/launch/upload', { method: 'POST', body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Upload failed');
    return result as { uri: string; proof: string };
  }
  async function prepare() {
    setBusy(true);
    setError('');
    try {
      if (!sessionWallet || !selected || selected.account.address !== sessionWallet)
        throw new Error('Connect signed-in wallet first.');
      if (!logo) throw new Error('Logo required.');
      const image = await upload(logo, 'logo');
      const uploadedBanner = banner ? await upload(banner, 'banner') : undefined;
      const result = await json('/api/launch/prepare', {
        ...form,
        imageUri: image.uri,
        imageProof: image.proof,
        bannerUri: uploadedBanner?.uri,
        bannerProof: uploadedBanner?.proof,
      });
      setPrepared(result);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare launch.');
    } finally {
      setBusy(false);
    }
  }
  async function resume(id: string) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/launch/${id}`, { cache: 'no-store' });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error || 'Could not load launch.');
      setForm((current) => ({ ...current, name: state.name, symbol: state.symbol }));
      if (state.status === 'LIVE') {
        setLive(state);
        setStep(3);
        return;
      }
      if (state.status === 'SUBMITTED') {
        setPrepared({
          id,
          mint: state.mint,
          feeAddress: state.feeAddress,
          transaction: '',
          estimatedLamports: 0,
          rewardMode: state.rewardMode,
          settlementEnabled: state.settlementEnabled,
        });
        setStep(2);
        return;
      }
      const fresh = await json(`/api/launch/${id}/retry`, {});
      setPrepared(fresh);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not resume launch.');
    } finally {
      setBusy(false);
    }
  }
  async function checkStatus() {
    if (!prepared) return;
    await resume(prepared.id);
  }
  async function signAndLaunch() {
    if (!selected || !prepared) return;
    setBusy(true);
    setError('');
    try {
      if (selected.account.address !== sessionWallet) throw new Error('Connect signed-in wallet.');
      const output = await (selected.wallet.features as SolanaSignTransactionFeature)[
        'solana:signTransaction'
      ].signTransaction({
        account: selected.account,
        transaction: decode(prepared.transaction),
        chain: 'solana:mainnet',
      });
      await json(`/api/launch/${prepared.id}/submit`, {
        transaction: encode(output[0].signedTransaction),
      });
      for (let i = 0; i < 30; i++) {
        const response = await fetch(`/api/launch/${prepared.id}`, { cache: 'no-store' });
        const result = await response.json();
        if (result.status === 'LIVE') {
          setLive(result);
          setStep(3);
          router.refresh();
          return;
        }
        if (result.status === 'FAILED') throw new Error(result.error || 'Launch failed on chain.');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error('Transaction submitted. Check launch status shortly.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not launch token.');
    } finally {
      setBusy(false);
    }
  }
  if (!enabled)
    return (
      <section className="panel">
        <h2>Launch unavailable</h2>
        <p>
          Launch opens when chain connection, media storage, and raid collection are configured.
        </p>
      </section>
    );
  return (
    <div className="creator-layout">
      <section className="panel launch-panel">
        <p className="status-pill">
          {step === 1
            ? '1 · Token details'
            : step === 2
              ? '2 · Review and sign'
              : '3 · Live and trading'}
        </p>
        {step === 1 && (
          <>
            <h2>Launch on pump.fun</h2>
            <p>Connect Solana wallet, add token details, then review creator-fee destination.</p>
            {recoveries.length > 0 && (
              <div className="campaign-manage">
                <strong>Unfinished launches</strong>
                {recoveries.map((r) => (
                  <p key={r.id}>
                    {r.name} (${r.symbol}) · {r.status}{' '}
                    <button
                      className="button secondary small"
                      disabled={busy}
                      onClick={() => void resume(r.id)}
                    >
                      Resume
                    </button>
                  </p>
                ))}
              </div>
            )}
            <div className="form-field">
              <label htmlFor="wallet">Solana wallet</label>
              <select
                id="wallet"
                value={selected?.wallet.name || ''}
                onChange={(e) => {
                  const wallet = wallets.find((w) => w.name === e.target.value);
                  if (wallet) void connect(wallet);
                }}
                disabled={busy}
              >
                <option value="">Select wallet</option>
                {wallets.map((w) => (
                  <option key={w.name}>{w.name}</option>
                ))}
              </select>
            </div>
            {selected && <p className="small-print">Connected: {selected.account.address}</p>}
            {sessionWallet && !selected && (
              <p className="small-print">
                Signed-in wallet: {sessionWallet}. Reconnect to sign launch.
              </p>
            )}
            {wallets.length === 0 && (
              <p className="small-print">
                Install Solana Wallet Standard compatible wallet to continue.
              </p>
            )}
            <div className="form-field">
              <label htmlFor="token-name">Name · {form.name.length}/32</label>
              <input
                id="token-name"
                maxLength={32}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Doge Coin"
              />
            </div>
            <div className="form-field">
              <label htmlFor="token-symbol">Ticker · {form.symbol.length}/10</label>
              <input
                id="token-symbol"
                maxLength={10}
                value={form.symbol}
                onChange={(e) => setForm({ ...form, symbol: e.target.value })}
                placeholder="DOGE"
              />
            </div>
            <div className="form-field">
              <label htmlFor="token-description">
                Description · {form.description.length}/1000
              </label>
              <textarea
                id="token-description"
                maxLength={1000}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label htmlFor="token-logo">Logo · PNG, JPG, GIF · max 5 MB</label>
              <input
                id="token-logo"
                type="file"
                accept="image/png,image/jpeg,image/gif"
                onChange={(e) => setLogo(e.target.files?.[0] || null)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="token-banner">Banner · optional</label>
              <input
                id="token-banner"
                type="file"
                accept="image/png,image/jpeg,image/gif"
                onChange={(e) => setBanner(e.target.files?.[0] || null)}
              />
            </div>
            {(['website', 'x', 'telegram', 'discord'] as const).map((key) => (
              <div className="form-field" key={key}>
                <label htmlFor={key}>{key[0].toUpperCase() + key.slice(1)} · optional</label>
                <input
                  id={key}
                  type="url"
                  placeholder="https://…"
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                />
              </div>
            ))}
            <button
              className="button"
              onClick={prepare}
              disabled={
                busy || !selected || !form.name || !form.symbol || !form.description || !logo
              }
            >
              {busy ? 'Preparing…' : 'Continue to review'}
            </button>
          </>
        )}
        {step === 2 && prepared && (
          <>
            <h2>Review launch</h2>
            {!selected && (
              <div className="form-field">
                <label htmlFor="resume-wallet">Reconnect signing wallet</label>
                <select
                  id="resume-wallet"
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
              </div>
            )}
            <p>
              <strong>
                {form.name} (${form.symbol})
              </strong>{' '}
              · pump.fun · SOL pair
            </p>
            <p>pump.fun’s standard SOL-pair creator-fee schedule applies.</p>
            <p>
              Creator fees go to useRAID-managed wallet{' '}
              <code className="mint">{prepared.feeAddress}</code>. After network costs: 90% to
              eligible raiders, 10% to platform. Launcher receives no separate fee share.
            </p>
            <p>
              Estimated minimum network/account cost:{' '}
              {(prepared.estimatedLamports / 1e9).toFixed(5)} SOL. Wallet may show higher actual
              protocol charges. No useRAID launch charge.
            </p>
            <p>
              {prepared.rewardMode === 'reviewed'
                ? `Rewards are paid after the 24-hour Raid is reviewed.${prepared.settlementEnabled ? '' : ' Payouts are not yet enabled.'}`
                : 'Hourly reward rounds.'}{' '}
              First raid lasts 24 hours. Mint: <code className="mint">{prepared.mint}</code>
            </p>
            {prepared.transaction ? (
              <button className="button" onClick={signAndLaunch} disabled={busy || !selected}>
                {busy ? 'Submitting…' : 'Approve and launch'}
              </button>
            ) : (
              <button className="button" onClick={() => void checkStatus()} disabled={busy}>
                {busy ? 'Checking…' : 'Check launch status'}
              </button>
            )}
          </>
        )}
        {step === 3 && live && (
          <>
            <h2>${form.symbol} is live</h2>
            <p>
              Mint: <code className="mint">{live.mint}</code>
            </p>
            <div className="form-actions">
              <a
                className="button"
                href={`https://pump.fun/coin/${live.mint}`}
                target="_blank"
                rel="noreferrer"
              >
                View on pump.fun
              </a>
              <Link className="button secondary" href={`/tokens/${live.mint}`}>
                Token page
              </Link>
              {live.raidId && (
                <Link className="button secondary" href={`/raids/${live.raidId}`}>
                  Launch raid
                </Link>
              )}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </section>
      <aside className="panel">
        <h2>How rewards work</h2>
        <p>
          pump.fun pays creator fees to token fee wallet. Qualifying raiders share 90% of collected
          fees after network costs, proportional to score, once the Raid&apos;s results are
          reviewed.
        </p>
        <p className="small-print">
          Launches and trading carry risk. useRAID.fun is not affiliated with pump.fun.
        </p>
      </aside>
    </div>
  );
}
