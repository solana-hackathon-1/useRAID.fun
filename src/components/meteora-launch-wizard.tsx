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
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  ImagePlus,
  ShieldCheck,
  Wallet as WalletIcon,
} from 'lucide-react';
import bs58 from 'bs58';
import type { LaunchTemplate, MeteoraNetwork } from '@/lib/meteora/amounts';
import s from './meteora.module.css';

type CompatibleWallet = Wallet &
  StandardConnectFeature &
  SolanaSignMessageFeature &
  SolanaSignTransactionFeature;
export type MeteoraWallet = { wallet: CompatibleWallet; account: WalletAccount };
export async function meteoraRequest(path: string, body?: unknown) {
  const response = await fetch(
    path,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed. Try again.');
  return result;
}
export const apiJson = meteoraRequest;
export async function signMeteoraTransaction(
  selected: MeteoraWallet,
  transaction: string,
  network: MeteoraNetwork,
) {
  const bytes = Uint8Array.from(atob(transaction), (c) => c.charCodeAt(0));
  const output = await (selected.wallet.features as SolanaSignTransactionFeature)[
    'solana:signTransaction'
  ].signTransaction({
    account: selected.account,
    transaction: bytes,
    chain: `solana:${network}`,
  });
  if (!output[0]?.signedTransaction) throw new Error('Wallet did not return a signed transaction.');
  return btoa(Array.from(output[0].signedTransaction, (b) => String.fromCharCode(b)).join(''));
}
export function useMeteoraWallet(network: MeteoraNetwork, sessionWallet: string | null) {
  const router = useRouter();
  const [wallets, setWallets] = useState<CompatibleWallet[]>([]);
  const [selected, setSelected] = useState<MeteoraWallet | null>(null);
  const [verifiedAddress, setVerifiedAddress] = useState(sessionWallet);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const registry = getWallets();
    const refresh = () =>
      setWallets(
        registry
          .get()
          .filter(
            (wallet): wallet is CompatibleWallet =>
              'standard:connect' in wallet.features &&
              'solana:signMessage' in wallet.features &&
              'solana:signTransaction' in wallet.features &&
              wallet.chains.includes(`solana:${network}`),
          ),
      );
    refresh();
    const register = registry.on('register', refresh),
      unregister = registry.on('unregister', refresh);
    return () => {
      register();
      unregister();
    };
  }, [network]);
  async function connect(wallet: CompatibleWallet) {
    setConnecting(true);
    setError('');
    try {
      const { accounts } = await (wallet.features as StandardConnectFeature)[
        'standard:connect'
      ].connect();
      const account = accounts.find((a) => a.chains.includes(`solana:${network}`));
      if (!account) throw new Error(`Choose a wallet account that supports Solana ${network}.`);
      if (sessionWallet && account.address !== sessionWallet)
        throw new Error('Reconnect your signed-in wallet to continue.');
      const challenge = await meteoraRequest('/api/wallet/challenge', { address: account.address });
      const result = (
        await (wallet.features as SolanaSignMessageFeature)['solana:signMessage'].signMessage({
          account,
          message: new TextEncoder().encode(challenge.message),
        })
      )[0];
      if (!result || new TextDecoder().decode(result.signedMessage) !== challenge.message)
        throw new Error('Wallet changed the sign-in message. Try connecting again.');
      await meteoraRequest('/api/wallet/verify', {
        digest: challenge.digest,
        address: account.address,
        signature: bs58.encode(result.signature),
      });
      setSelected({ wallet, account });
      setVerifiedAddress(account.address);
      router.refresh();
      return { wallet, account };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet connection failed.');
      return null;
    } finally {
      setConnecting(false);
    }
  }
  async function sign(transaction: string) {
    if (!selected || selected.account.address !== verifiedAddress)
      throw new Error('Reconnect your verified wallet.');
    return signMeteoraTransaction(selected, transaction, network);
  }
  return { wallets, selected, verifiedAddress, connecting, error, connect, sign };
}

type LaunchState = {
  id: string;
  mint: string;
  name: string;
  symbol: string;
  status: string;
  network: MeteoraNetwork;
  raidId: string | null;
  signature: string | null;
  error?: string | null;
  completed?: number;
  estimatedLamports?: number;
  estimateLabel?: string;
  step: {
    id: string;
    key: string;
    label: string;
    status: string;
    transaction: string | null;
    signature: string | null;
    error?: string | null;
  } | null;
};
type Props = {
  readiness: {
    enabled: boolean;
    network: MeteoraNetwork;
    issues: string[];
    template: LaunchTemplate;
  };
  walletAddress: string | null;
  signedIn: boolean;
  recoveries: { id: string; name: string; symbol: string; status: string; mint?: string }[];
};
const setupLabels = ['Fee sharing', 'Launch economics', 'Token launch'];
export function MeteoraLaunchWizard({ readiness, walletAddress, signedIn, recoveries }: Props) {
  const router = useRouter();
  const wallet = useMeteoraWallet(readiness.network, walletAddress);
  const [stage, setStage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [polling, setPolling] = useState(false);
  const [launch, setLaunch] = useState<LaunchState | null>(null);
  const [form, setForm] = useState({
    name: '',
    symbol: '',
    description: '',
    website: '',
    x: '',
    telegram: '',
  });
  const [logo, setLogo] = useState<File | null>(null);
  const [image, setImage] = useState('');
  const [terms, setTerms] = useState(false);
  const [copied, setCopied] = useState(false);
  const live = launch?.status === 'LIVE';
  const template = readiness.template;
  useEffect(() => {
    if (!logo) return;
    const url = URL.createObjectURL(logo);
    setImage(url);
    return () => URL.revokeObjectURL(url);
  }, [logo]);
  useEffect(() => {
    if (launch?.step?.status !== 'SUBMITTED') return;
    let cancelled = false,
      tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    setPolling(true);
    const check = async () => {
      try {
        const result: LaunchState = await meteoraRequest(`/api/launch/${launch.id}`);
        if (cancelled) return;
        setLaunch(result);
        if (result.status === 'LIVE' || result.step?.status !== 'SUBMITTED') {
          setPolling(false);
          router.refresh();
          return;
        }
        if (++tries < 30) timer = setTimeout(check, 2000);
        else setPolling(false);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not check confirmation.');
          setPolling(false);
        }
      }
    };
    timer = setTimeout(check, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [launch?.id, launch?.step?.id, launch?.step?.status, router]);
  async function resume(id: string) {
    setBusy(true);
    setError('');
    try {
      setLaunch(await meteoraRequest(`/api/launch/${id}`));
      setStage(3);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not resume launch.');
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    setBusy(true);
    setError('');
    try {
      if (!wallet.selected || !wallet.verifiedAddress)
        throw new Error('Connect your signing wallet first.');
      if (!logo) throw new Error('Choose a token image.');
      const data = new FormData();
      data.append('kind', 'logo');
      data.append('file', logo);
      const response = await fetch('/api/launch/upload', { method: 'POST', body: data });
      const uploaded = await response.json();
      if (!response.ok) throw new Error(uploaded.error || 'Image upload failed.');
      const result: LaunchState = await meteoraRequest('/api/launch/prepare', {
        ...form,
        provider: 'METEORA',
        imageUri: uploaded.uri,
        imageProof: uploaded.proof,
      });
      setLaunch(result);
      if (result.error) setError(result.error);
      setStage(3);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare launch.');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  async function sign() {
    if (!launch?.step?.transaction || !wallet.selected) return;
    setBusy(true);
    setError('');
    try {
      if (wallet.selected.account.address !== wallet.verifiedAddress)
        throw new Error('Reconnect your verified wallet.');
      const transaction = await signMeteoraTransaction(
        wallet.selected,
        launch.step.transaction,
        readiness.network,
      );
      const result: LaunchState = await meteoraRequest(`/api/launch/${launch.id}/submit`, {
        stepId: launch.step.id,
        transaction,
      });
      setLaunch(result);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not submit launch. Your progress is saved.',
      );
    } finally {
      setBusy(false);
    }
  }
  function chooseImage(file: File | null) {
    setError('');
    if (
      file &&
      (!['image/png', 'image/jpeg', 'image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024)
    ) {
      setError('Choose a PNG, JPG or GIF smaller than 5 MB.');
      return;
    }
    setLogo(file);
    if (!file) setImage('');
  }
  async function copyMint() {
    try {
      await navigator.clipboard.writeText(launch!.mint);
      setCopied(true);
    } catch {
      setError('Copy the token address shown below.');
    }
  }
  function share() {
    if (!launch) return;
    const url = `${window.location.origin}/tokens/${launch.mint}`;
    const text = `$${launch.symbol} is live on useRAID. 20% of distributable trading fees fund community rewards.\n${url}\nToken: ${launch.mint}`;
    window.open(
      `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`,
      '_blank',
      'noopener,noreferrer',
    );
  }
  const walletControl = (
    <div className={s.field}>
      <label htmlFor="meteora-wallet">
        <WalletIcon size={16} aria-hidden /> Signing wallet
      </label>
      <select
        id="meteora-wallet"
        value={wallet.selected?.wallet.name || ''}
        disabled={busy || wallet.connecting || !readiness.enabled}
        onChange={(event) => {
          const match = wallet.wallets.find((w) => w.name === event.target.value);
          if (match) void wallet.connect(match);
        }}
      >
        <option value="">{wallet.connecting ? 'Connecting…' : 'Connect wallet'}</option>
        {wallet.wallets.map((w) => (
          <option key={w.name} value={w.name}>
            {w.name}
          </option>
        ))}
      </select>
      {wallet.verifiedAddress && (
        <small className={s.address}>
          {wallet.selected ? 'Connected' : 'Reconnect to sign'}: {wallet.verifiedAddress}
        </small>
      )}
      {!wallet.wallets.length && readiness.enabled && (
        <small>Open this page in a browser with a Solana wallet installed.</small>
      )}
      {!signedIn && !wallet.verifiedAddress && (
        <small>Sign a message to connect. No network fee.</small>
      )}
    </div>
  );
  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <Link className={s.back} href="/creator">
            <ArrowLeft size={16} /> Creator Studio
          </Link>
          <h1>{live ? `${launch.symbol} is live.` : 'Launch. Trade. Raid.'}</h1>
          <p>
            {live
              ? 'Your token is trading. Add your X post to turn community attention into rewards.'
              : 'Launch a token whose trading fees keep funding its community.'}
          </p>
        </div>
        <span className={s.network}>
          {readiness.network === 'devnet' ? 'Devnet · test tokens' : 'Solana mainnet'}
        </span>
      </header>
      {!readiness.enabled && (
        <div className={s.notice} role="status">
          <strong>Launch setup in progress</strong>
          <p>
            You can review the launch template below. Wallet signatures open once these services are
            ready.
          </p>
          <ul>
            {readiness.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={s.grid}>
        <section className={s.card}>
          {!live && (
            <ol className={s.steps} aria-label="Launch progress">
              {['Token', 'Raid allocation', 'Review & sign'].map((title, index) => (
                <li key={title} aria-current={stage === index + 1 ? 'step' : undefined}>
                  <span>{stage > index + 1 ? <Check size={13} /> : index + 1}</span>
                  {title}
                </li>
              ))}
            </ol>
          )}
          {recoveries.length > 0 && !launch && (
            <div className={s.recoveries}>
              <strong>Pick up where you left off</strong>
              {recoveries.map((recovery) => (
                <div className={s.row} key={recovery.id}>
                  <span>
                    {recovery.name} <small>${recovery.symbol}</small>
                  </span>
                  <button
                    className={s.secondary}
                    disabled={busy || !readiness.enabled}
                    onClick={() => void resume(recovery.id)}
                  >
                    Resume
                  </button>
                </div>
              ))}
            </div>
          )}
          {stage === 1 && !live && (
            <form
              className={s.form}
              onSubmit={(event) => {
                event.preventDefault();
                setError('');
                if (new TextEncoder().encode(form.name.trim()).length > 32) {
                  setError('Token name must fit 32 UTF-8 bytes. Shorten names with emoji or accented characters.');
                  return;
                }
                setStage(2);
              }}
            >
              <div className={s.sectionHeading}>
                <h2>Your token</h2>
                <p>Give your community a name and a face.</p>
              </div>
              <div className={s.tokenInputs}>
                <label className={s.imageUpload} htmlFor="meteora-image">
                  {image ? (
                    <img src={image} alt="Your token image preview" />
                  ) : (
                    <>
                      <ImagePlus size={24} />
                      <span>Add image</span>
                    </>
                  )}
                  <input
                    id="meteora-image"
                    type="file"
                    accept="image/png,image/jpeg,image/gif"
                    onChange={(event) => chooseImage(event.target.files?.[0] || null)}
                  />
                  <small>PNG, JPG, GIF · 5 MB</small>
                </label>
                <div className={s.form}>
                  <div className={s.field}>
                    <label htmlFor="meteora-name">Token name</label>
                    <input
                      id="meteora-name"
                      required
                      maxLength={32}
                      placeholder="Your community"
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </div>
                  <div className={s.field}>
                    <label htmlFor="meteora-symbol">Ticker</label>
                    <input
                      id="meteora-symbol"
                      required
                      pattern="[A-Za-z0-9]{1,10}"
                      maxLength={10}
                      placeholder="TOKEN"
                      value={form.symbol}
                      onChange={(event) =>
                        setForm({ ...form, symbol: event.target.value.toUpperCase() })
                      }
                    />
                    <small>1–10 letters or numbers</small>
                  </div>
                </div>
              </div>
              <div className={s.field}>
                <label htmlFor="meteora-description">
                  Description <small>Optional</small>
                </label>
                <textarea
                  id="meteora-description"
                  maxLength={1000}
                  placeholder="What brings your community together?"
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </div>
              <details className={s.details}>
                <summary>Links and socials</summary>
                <div className={s.form}>
                  {(['website', 'x', 'telegram'] as const).map((key) => (
                    <div className={s.field} key={key}>
                      <label htmlFor={`meteora-${key}`}>
                        {key === 'x' ? 'X profile' : key === 'telegram' ? 'Telegram' : 'Website'}
                      </label>
                      <input
                        id={`meteora-${key}`}
                        type="url"
                        pattern="https://.*"
                        placeholder="https://…"
                        value={form[key]}
                        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
                      />
                    </div>
                  ))}
                </div>
              </details>
              {walletControl}
              <button
                className={s.button}
                type="submit"
                disabled={busy || !logo || !form.name.trim() || !form.symbol.trim()}
              >
                Continue to raid allocation
              </button>
            </form>
          )}
          {stage === 2 && !live && (
            <div className={s.form}>
              <div className={s.sectionHeading}>
                <h2>Give trading a purpose.</h2>
                <p>Every launch uses the same community reward template.</p>
              </div>
              <div className={s.allocation}>
                <div className={s.row}>
                  <h3>Trading fee revenue</h3>
                  <span className={s.chip}>Recommended</span>
                </div>
                <div className={s.splitBar}>
                  <span style={{ width: '80%' }} />
                  <span style={{ width: '20%' }} />
                </div>
                <div className={s.splitLabels}>
                  <div>
                    <strong>80%</strong>
                    <span>Creator</span>
                  </div>
                  <div>
                    <strong>20%</strong>
                    <span>Community raids</span>
                  </div>
                </div>
                <p>
                  Applies to distributable launch fees after Meteora protocol fees. Trading fee
                  stays fixed at 1% before and after graduation.
                </p>
              </div>
              <div className={s.allocation}>
                <div className={s.row}>
                  <h3>Token reward reserve</h3>
                  <strong>5%</strong>
                </div>
                <p>
                  <strong>50 million {form.symbol || 'tokens'}</strong> reserved for raiders.
                  Unlocks after graduation. SOL fee rewards can fund raids earlier.
                </p>
              </div>
              <div className={s.notice}>
                <ShieldCheck size={20} />
                <div>
                  <strong>Built for a lasting community</strong>
                  <p>
                    1 billion fixed supply. Immutable token. Liquidity permanently locked after
                    graduation.
                  </p>
                </div>
              </div>
              <details className={s.details}>
                <summary>Full launch configuration</summary>
                <dl className={s.configuration}>
                  <div>
                    <dt>Network</dt>
                    <dd>Solana {readiness.network}</dd>
                  </div>
                  <div>
                    <dt>Supply / decimals</dt>
                    <dd>1B / 6</dd>
                  </div>
                  <div>
                    <dt>Trading pair</dt>
                    <dd>SOL</dd>
                  </div>
                  <div>
                    <dt>Graduation target</dt>
                    <dd>{template.graduationSol} SOL</dd>
                  </div>
                  <div>
                    <dt>Supply for migration liquidity</dt>
                    <dd>20%</dd>
                  </div>
                  <div>
                    <dt>Destination</dt>
                    <dd>Meteora DAMM v2</dd>
                  </div>
                  <div>
                    <dt>Dynamic trading fees</dt>
                    <dd>Off</dd>
                  </div>
                  <div>
                    <dt>Mint / freeze authority</dt>
                    <dd>None</dd>
                  </div>
                  <div>
                    <dt>useRAID platform share</dt>
                    <dd>0%</dd>
                  </div>
                </dl>
                <p className={s.small}>
                  Reserve and migration supply are separate allocations. SDK calculates curve
                  amounts at launch; exact configuration is published on the token page.
                </p>
              </details>
              <label className={s.checkbox}>
                <input
                  type="checkbox"
                  checked={terms}
                  onChange={(event) => setTerms(event.target.checked)}
                />
                <span>
                  I reviewed the immutable configuration. Token trading carries risk; no extra
                  useRAID launch charge. Network rent and Meteora costs apply.
                </span>
              </label>
              {!wallet.selected && walletControl}
              <div className={s.actions}>
                <button className={s.secondary} disabled={busy} onClick={() => setStage(1)}>
                  Back
                </button>
                <button
                  className={s.button}
                  disabled={busy || !readiness.enabled || !terms || !wallet.selected}
                  onClick={() => void prepare()}
                >
                  {busy ? 'Preparing launch…' : 'Prepare launch'}
                </button>
              </div>
            </div>
          )}
          {stage === 3 && launch && !live && (
            <div className={s.form}>
              <div className={s.sectionHeading}>
                <h2>Review and sign</h2>
                <p>
                  {launch.name} <strong>${launch.symbol}</strong> · SOL pair
                </p>
              </div>
              <p>
                Your launch needs three wallet approvals. Confirmed steps are saved, so you can
                safely return and resume.
              </p>
              <ol className={s.signSteps}>
                {setupLabels.map((label, index) => (
                  <li key={label} className={(launch.completed || 0) > index ? s.complete : ''}>
                    <span>{(launch.completed || 0) > index ? <Check size={16} /> : index + 1}</span>
                    <div>
                      <strong>{label}</strong>
                      <small>
                        {(launch.completed || 0) > index
                          ? 'Confirmed'
                          : launch.step?.key === ['vault', 'config', 'pool'][index]
                            ? launch.step.status === 'SUBMITTED'
                              ? 'Waiting for final confirmation'
                              : 'Ready for your approval'
                            : 'Next'}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
              <div className={s.reviewCost}>
                <span>{launch.estimateLabel || 'Account rent and network fees'}</span>
                <strong>
                  {launch.estimatedLamports !== undefined
                    ? `${(launch.estimatedLamports / 1e9).toFixed(6)} SOL`
                    : 'Refresh to estimate next step'}
                </strong>
                <small>
                  Estimate for this approval. Your wallet shows the final transaction. No useRAID
                  launch charge.
                </small>
              </div>
              <div className={s.field}>
                <label>Token address</label>
                <code className={s.address}>{launch.mint}</code>
              </div>
              {!wallet.selected && walletControl}
              {launch.step?.status === 'PLANNED' && launch.step.transaction ? (
                <button
                  className={s.button}
                  disabled={
                    busy ||
                    !wallet.selected ||
                    !readiness.enabled ||
                    launch.estimatedLamports === undefined
                  }
                  onClick={() => void sign()}
                >
                  {busy ? 'Waiting for wallet…' : `Sign step ${(launch.completed || 0) + 1} of 3`}
                </button>
              ) : (
                <button
                  className={s.button}
                  disabled={busy || polling}
                  onClick={() => void resume(launch.id)}
                >
                  {polling ? 'Confirming on Solana…' : busy ? 'Checking…' : 'Check launch status'}
                </button>
              )}
              <button
                className={s.textButton}
                disabled={busy || polling}
                onClick={() => void resume(launch.id)}
              >
                Refresh saved launch
              </button>
              {launch.step?.signature && (
                <a
                  className={s.small}
                  href={`https://solscan.io/tx/${launch.step.signature}${readiness.network === 'devnet' ? '?cluster=devnet' : ''}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View current transaction <ExternalLink size={12} />
                </a>
              )}
              <p className={s.small}>
                If you reject a signature, this launch stays saved. Reconnect the same wallet and
                resume here.
              </p>
            </div>
          )}
          {live && (
            <div className={s.form}>
              <div className={s.liveIcon}>
                <Check size={28} />
              </div>
              <div className={s.sectionHeading}>
                <h2>Token live. RAID ready.</h2>
                <p>
                  Your launch raid is already created. Add an X post, then start when its SOL reward
                  balance reaches {template.minimumCampaignSol} SOL.
                </p>
              </div>
              <div className={s.successSteps}>
                <p>
                  <Check size={16} /> Token is trading
                </p>
                <p>
                  <Check size={16} /> Community fee vault is ready
                </p>
                <p>
                  <span className={s.nextDot} /> Add your X post and start a raid
                </p>
              </div>
              <div className={s.actions}>
                <Link className={s.button} href={`/launch/${launch.id}/campaign`}>
                  Set up launch raid
                </Link>
                <Link className={s.secondary} href={`/tokens/${launch.mint}`}>
                  View token
                </Link>
              </div>
              <div className={s.field}>
                <label>Token address</label>
                <div className={s.copyRow}>
                  <code className={s.address}>{launch.mint}</code>
                  <button
                    className={s.iconButton}
                    aria-label="Copy token address"
                    onClick={() => void copyMint()}
                  >
                    {copied ? <Check size={17} /> : <Copy size={17} />}
                  </button>
                </div>
              </div>
              <button className={s.secondary} onClick={share}>
                Share the launch on X <ExternalLink size={15} />
              </button>
              {launch.signature && (
                <a
                  className={s.small}
                  href={`https://solscan.io/tx/${launch.signature}${readiness.network === 'devnet' ? '?cluster=devnet' : ''}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View launch transaction <ExternalLink size={12} />
                </a>
              )}
            </div>
          )}
          {(error || wallet.error) && (
            <p className={s.error} role="alert">
              {error || wallet.error}
            </p>
          )}
        </section>
        <aside className={s.summary} aria-label="Your launch summary">
          <div className={s.previewIdentity}>
            {image ? (
              <img src={image} alt="" />
            ) : (
              <div className={s.tokenPlaceholder}>
                {(launch?.symbol || form.symbol || 'RAID').slice(0, 2)}
              </div>
            )}
            <div>
              <h2>{launch?.name || form.name || 'Your next community'}</h2>
              <p>${launch?.symbol || form.symbol || 'TOKEN'}</p>
            </div>
          </div>
          <div className={s.flywheel}>
            <p>Trading</p>
            <span aria-hidden>↓</span>
            <p>Community rewards</p>
            <span aria-hidden>↓</span>
            <p>More attention</p>
          </div>
          <dl className={s.configuration}>
            <div>
              <dt>Creator fee share</dt>
              <dd>80%</dd>
            </div>
            <div>
              <dt>Raid fee share</dt>
              <dd>20%</dd>
            </div>
            <div>
              <dt>Token reserve</dt>
              <dd>50M</dd>
            </div>
            <div>
              <dt>Trading fee</dt>
              <dd>1%</dd>
            </div>
            <div>
              <dt>Graduation</dt>
              <dd>{template.graduationSol} SOL</dd>
            </div>
          </dl>
          <p className={s.small}>
            SOL fees fund raids before graduation. Token reserves unlock after graduation. Each
            asset stays separate.
          </p>
          <div className={s.trust}>
            <ShieldCheck size={16} />
            <span>Fixed supply · Locked liquidity</span>
          </div>
          {readiness.network === 'devnet' && (
            <p className={s.small}>
              Devnet is for testing. These tokens and SOL have no mainnet value.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
