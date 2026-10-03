'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Check, X, Coins, MessageSquare, Rocket } from 'lucide-react';
import { formatUsdc, units, quoteUsdc } from '@/lib/usdc-amount';
import type { TargetPreview } from '@/lib/studio-targets';

export type StudioDraft = {
  id?: string;
  projectType: 'PROJECT' | 'TOKEN';
  title: string;
  description: string;
  mint: string;
  name: string;
  symbol: string;
  imageUri: string;
  targetPosts: { url: string; preview?: TargetPreview | null; error?: string }[];
  impressionTarget: number;
  duration: number;
};
const blank = (type: 'PROJECT' | 'TOKEN'): StudioDraft => ({
  projectType: type,
  title: '',
  description: '',
  mint: '',
  name: '',
  symbol: '',
  imageUri: '',
  targetPosts: [{ url: '' }],
  impressionTarget: 10000,
  duration: 24,
});
export function StudioEditor({
  initial,
  path,
  available,
  rate,
  ownerId,
  walletConnected,
}: {
  initial: StudioDraft | null;
  path?: string;
  available: string;
  rate: string | null;
  ownerId: string;
  walletConnected: boolean;
}) {
  const router = useRouter(),
    loaded = useRef(false);
  const [draft, setDraft] = useState<StudioDraft>(
    initial || blank(path === 'token' ? 'TOKEN' : 'PROJECT'),
  );
  const [chosen, setChosen] = useState(!!initial || !!path),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState(false);
  const [terms, setTerms] = useState(false),
    [tokenLoading, setTokenLoading] = useState(false),
    [tokenResolved, setTokenResolved] = useState(!!initial?.name),
    [tokenError, setTokenError] = useState('');
  const [checking, setChecking] = useState<number | null>(null);
  const [budgetText, setBudgetText] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<StudioDraft | null>(null);
  const storageKey = `useraid-studio-draft:${ownerId}`;
  useEffect(() => {
    if (
      draft.projectType !== 'TOKEN' ||
      tokenResolved ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(draft.mint)
    )
      return;
    const timer = setTimeout(() => void lookupToken(), 500);
    return () => clearTimeout(timer);
  }, [draft.mint, draft.projectType, tokenResolved]);
  useEffect(() => {
    if (!initial && !path) {
      try {
        const saved = sessionStorage.getItem(storageKey);
        if (saved) {
          setRecovered(JSON.parse(saved));
        }
      } catch {}
    }
    loaded.current = true;
  }, [initial, path, storageKey]);
  useEffect(() => {
    if (loaded.current && chosen) sessionStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft, chosen, storageKey]);
  let pool: bigint | null = null;
  try {
    if (rate) pool = quoteUsdc(draft.impressionTarget, BigInt(rate));
  } catch {}
  const insufficient = pool !== null && pool > BigInt(available);
  function update(values: Partial<StudioDraft>) {
    setDraft((d) => ({ ...d, ...values }));
  }
  function commitBudget() {
    if (budgetText === null || !rate) return;
    try {
      const target = Number((units(budgetText) * 1000n) / BigInt(rate));
      if (target < 1000 || target > 1_000_000_000)
        throw Error('Choose a budget for 1,000–1,000,000,000 impressions.');
      update({ impressionTarget: target });
      setBudgetText(null);
      setMessage('');
    } catch (e) {
      setError(true);
      setMessage(e instanceof Error ? e.message : 'Invalid budget.');
    }
  }
  async function request(url: string, data?: unknown, method = 'POST') {
    const response = await fetch(
      url,
      data
        ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
        : {},
    );
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Request failed.');
    return body;
  }
  async function save() {
    const value = {
      ...draft,
      studioVersion: 1,
      targetPosts: draft.targetPosts.filter((p) => p.url.trim()).map((p) => p.url.trim()),
      action: 'save',
    };
    const saved = await request(
      draft.id ? `/api/raids/${draft.id}` : '/api/raids',
      value,
      draft.id ? 'PATCH' : 'POST',
    );
    update({ id: saved.id });
    return saved.id as string;
  }
  async function action(launch: boolean) {
    setBusy(true);
    setMessage('');
    setError(false);
    try {
      if (budgetText !== null) throw Error('Finish editing the budget before saving or funding.');
      const id = await save();
      if (launch && !walletConnected) {
        router.push(`/creator/account?returnTo=${encodeURIComponent(`/creator/new?draft=${id}`)}`);
        return;
      }
      if (launch && insufficient) {
        router.push(`/creator/balance?returnTo=${encodeURIComponent(`/creator/new?draft=${id}`)}`);
        return;
      }
      if (launch) {
        await request(
          `/api/raids/${id}`,
          { action: 'fund-launch', expectedUnits: pool?.toString(), termsAccepted: terms },
          'PATCH',
        );
        sessionStorage.removeItem(storageKey);
        router.push(`/creator/raids/${id}`);
        router.refresh();
      } else {
        setMessage('Draft saved.');
        router.replace(`/creator/new?draft=${id}`);
      }
    } catch (e) {
      setError(true);
      setMessage(e instanceof Error ? e.message : 'Unable to save Raid.');
    } finally {
      setBusy(false);
    }
  }
  async function checkPost(index: number) {
    setChecking(index);
    try {
      const preview = await request(
        `/api/studio/preview?type=post&url=${encodeURIComponent(draft.targetPosts[index].url)}`,
      );
      if (draft.targetPosts.some((p, i) => i !== index && p.preview?.id === preview.id))
        throw Error('This post is already added.');
      setDraft((d) => ({
        ...d,
        targetPosts: d.targetPosts.map((p, i) => (i === index ? { ...p, preview, error: '' } : p)),
      }));
    } catch (e) {
      setDraft((d) => ({
        ...d,
        targetPosts: d.targetPosts.map((p, i) =>
          i === index
            ? { ...p, preview: null, error: e instanceof Error ? e.message : 'Post unavailable.' }
            : p,
        ),
      }));
    } finally {
      setChecking(null);
    }
  }
  async function lookupToken() {
    setTokenLoading(true);
    setTokenError('');
    try {
      const token = await request(
        `/api/studio/preview?type=token&mint=${encodeURIComponent(draft.mint)}`,
      );
      update({
        name: token.name,
        symbol: token.symbol,
        imageUri: token.imageUri || '',
        title: draft.title || (token.name ? `${token.name} Raid` : ''),
      });
      setTokenResolved(true);
    } catch (e) {
      setTokenResolved(true);
      setTokenError(
        e instanceof Error ? e.message : 'Metadata unavailable. Enter missing details below.',
      );
    } finally {
      setTokenLoading(false);
    }
  }
  if (!chosen)
    return (
      <div className="studio">
        <Link className="studio-back" href="/creator">
          <ArrowLeft size={16} /> Creator Studio
        </Link>
        <header className="studio-heading">
          <div>
            <h1>Create Raid</h1>
            <p>How do you want to start?</p>
          </div>
          {recovered && (
            <button
              className="button secondary"
              onClick={() => {
                setDraft(recovered);
                setChosen(true);
              }}
            >
              Resume draft
            </button>
          )}
        </header>
        <div className="studio-paths">
          <button
            className="studio-path"
            onClick={() => {
              setDraft(blank('PROJECT'));
              setChosen(true);
            }}
          >
            <MessageSquare size={28} />
            <h2>X Campaign</h2>
            <p>No token needed. Fund a Raid around X posts.</p>
            <span>
              Start X Campaign <ArrowLeft className="studio-arrow-forward" size={17} />
            </span>
          </button>
          <button
            className="studio-path"
            onClick={() => {
              setDraft(blank('TOKEN'));
              setChosen(true);
            }}
          >
            <Coins size={28} />
            <h2>Existing Token</h2>
            <p>Identify your token, then bring your community to X posts.</p>
            <span>
              Start Token Raid <ArrowLeft className="studio-arrow-forward" size={17} />
            </span>
          </button>
          <div className="studio-path coming">
            <Rocket size={28} />
            <h2>Launch Token</h2>
            <p>Launch with community rewards built in.</p>
            <span>Coming soon</span>
          </div>
        </div>
      </div>
    );
  return (
    <div className="studio">
      <Link className="studio-back" href="/creator">
        <ArrowLeft size={16} /> Creator Studio
      </Link>
      <header className="studio-heading">
        <div>
          <h1>{draft.projectType === 'TOKEN' ? 'Create Token Raid' : 'Create X Campaign'}</h1>
          <p>Posts first. Choose your reach. Fund your community.</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void action(false)}
        >
          {busy ? 'Saving…' : 'Save draft'}
        </button>
      </header>
      <form
        className="studio-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void action(true);
        }}
      >
        <div className="studio-editor-fields">
          {draft.projectType === 'TOKEN' && (
            <section className="studio-section">
              <h2>Your token</h2>
              <label className="field">
                Solana contract address
                <input
                  value={draft.mint}
                  disabled={tokenLoading}
                  onChange={(e) => {
                    update({ mint: e.target.value, name: '', symbol: '', imageUri: '' });
                    setTokenResolved(false);
                  }}
                  placeholder="Paste Solana CA"
                  required
                />
              </label>
              <button
                type="button"
                className="button secondary small"
                disabled={tokenLoading || !draft.mint}
                onClick={() => void lookupToken()}
              >
                {tokenLoading ? 'Finding token…' : 'Find token'}
              </button>
              {tokenError && <p className="message error">{tokenError}</p>}
              {tokenResolved && (
                <div className="studio-token-details">
                  {draft.imageUri ? (
                    <img alt="" src={draft.imageUri} className="studio-token-image" />
                  ) : (
                    <span className="studio-token-placeholder">
                      {draft.symbol.slice(0, 2) || '?'}
                    </span>
                  )}
                  <div>
                    <strong>{draft.name || 'Token details'}</strong>
                    <p>{draft.symbol}</p>
                    <span className="small-print">
                      {draft.mint.slice(0, 6)}…{draft.mint.slice(-4)}
                    </span>
                  </div>
                  {draft.name && draft.symbol && (
                    <span className="studio-connected">
                      <Check size={15} /> Token found
                    </span>
                  )}
                </div>
              )}
              {tokenResolved && (!draft.name || !draft.symbol || tokenError) && (
                <div className="form-grid">
                  <label className="field">
                    Token name
                    <input
                      value={draft.name}
                      maxLength={80}
                      required
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    Ticker
                    <input
                      value={draft.symbol}
                      maxLength={15}
                      required
                      onChange={(e) => update({ symbol: e.target.value })}
                    />
                  </label>
                </div>
              )}
              {tokenResolved && !draft.imageUri && (
                <label className="field">
                  Token image (optional)
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const data = new FormData();
                      data.set('file', file);
                      try {
                        const response = await fetch('/api/studio/image', {
                          method: 'POST',
                          body: data,
                        });
                        const body = await response.json();
                        if (!response.ok) throw Error(body.error);
                        update({ imageUri: body.imageUri });
                      } catch (err) {
                        setTokenError(err instanceof Error ? err.message : 'Image upload failed.');
                      }
                    }}
                  />
                  <small>PNG, JPG, or GIF, under 250 KB.</small>
                </label>
              )}
            </section>
          )}
          <section className="studio-section">
            <label className="field">
              <h2>Campaign name</h2>
              <input
                value={draft.title}
                onChange={(e) => update({ title: e.target.value })}
                placeholder="What are we raiding?"
                minLength={3}
                maxLength={120}
                required
              />
            </label>
          </section>
          <section className="studio-section">
            <h2>What should community Raid?</h2>
            <p>Add public X posts you want contributors to quote or share.</p>
            {draft.targetPosts.map((post, index) => (
              <div className="studio-post-input" key={index}>
                <div className="studio-url-row">
                  <label className="field">
                    X post {index + 1}
                    <input
                      type="url"
                      disabled={checking !== null}
                      value={post.url}
                      placeholder="https://x.com/project/status/…"
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          targetPosts: d.targetPosts.map((p, i) =>
                            i === index ? { url: e.target.value } : p,
                          ),
                        }))
                      }
                    />
                  </label>
                  <button
                    className="button secondary small"
                    type="button"
                    disabled={checking !== null || !post.url}
                    onClick={() => void checkPost(index)}
                  >
                    {checking === index ? 'Checking…' : post.preview ? 'Refresh' : 'Preview'}
                  </button>
                  {draft.targetPosts.length > 1 && (
                    <button
                      className="icon-button"
                      aria-label={`Remove post ${index + 1}`}
                      type="button"
                      disabled={checking !== null}
                      onClick={() =>
                        update({ targetPosts: draft.targetPosts.filter((_, i) => i !== index) })
                      }
                    >
                      <X size={18} />
                    </button>
                  )}
                </div>
                {post.preview && (
                  <div className="studio-post-preview">
                    <strong>{post.preview.handle ? `@${post.preview.handle}` : 'X post'}</strong>
                    <p>{post.preview.text}</p>
                    <span className="studio-connected">
                      <Check size={14} /> Public post found
                    </span>
                  </div>
                )}
                {post.error && (
                  <p role="alert" className="message error">
                    {post.error}
                  </p>
                )}
              </div>
            ))}
            <button
              type="button"
              className="inline-link studio-add"
              disabled={draft.targetPosts.length >= 100 || checking !== null}
              onClick={() => update({ targetPosts: [...draft.targetPosts, { url: '' }] })}
            >
              <Plus size={15} /> Add another post
            </button>
          </section>
          <section className="studio-section">
            <h2>Reach and reward pool</h2>
            <p>Set your impression target. Verified contributor views earn from your pool.</p>
            <div className="form-grid">
              <label className="field">
                Impression target
                <input
                  type="number"
                  min={1000}
                  max={1000000000}
                  value={draft.impressionTarget}
                  required
                  onChange={(e) => {
                    setBudgetText(null);
                    update({ impressionTarget: Number(e.target.value) });
                  }}
                />
              </label>
              <label className="field">
                Reward budget (USDC)
                <input
                  type="text"
                  inputMode="decimal"
                  disabled={!rate}
                  value={budgetText ?? (pool === null ? '' : formatUsdc(pool).replaceAll(',', ''))}
                  placeholder="Pricing unavailable"
                  onChange={(e) => setBudgetText(e.target.value)}
                  onBlur={commitBudget}
                />
              </label>
            </div>
            <p className="small-print">
              {rate
                ? `${formatUsdc(rate)} USDC per 1,000 observed impressions. Any unused budget returns to your balance after review.`
                : 'Pricing is not configured. Save a draft while funding is unavailable.'}
            </p>
          </section>
          <section className="studio-section">
            <h2>Duration</h2>
            <div className="studio-durations" aria-label="Campaign duration">
              {[
                [6, '6h'],
                [12, '12h'],
                [24, '24h'],
                [72, '3d'],
                [168, '7d'],
              ].map(([hours, label]) => (
                <button
                  key={hours}
                  type="button"
                  aria-pressed={draft.duration === hours}
                  onClick={() => update({ duration: Number(hours) })}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="small-print">Ends at target or chosen duration, whichever comes first.</p>
          </section>
          <details className="studio-section">
            <summary>More options</summary>
            <label className="field">
              Description (optional)
              <textarea
                value={draft.description}
                maxLength={2000}
                onChange={(e) => update({ description: e.target.value })}
              />
            </label>
          </details>
        </div>
        <aside className="studio-launch-summary" id="launch-summary">
          <h2>Your Raid</h2>
          <p>{draft.title || 'Untitled campaign'}</p>
          <dl>
            <div>
              <dt>Target posts</dt>
              <dd>{draft.targetPosts.filter((p) => p.url.trim()).length}</dd>
            </div>
            <div>
              <dt>Impression target</dt>
              <dd>{draft.impressionTarget.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{draft.duration} hours</dd>
            </div>
            <div>
              <dt>Reward pool</dt>
              <dd>{pool !== null ? formatUsdc(pool) : '—'} USDC</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>{formatUsdc(available)} USDC</dd>
            </div>
            <div className="studio-summary-total">
              <dt>After launch</dt>
              <dd>
                {pool !== null && !insufficient ? formatUsdc(BigInt(available) - pool) : '—'} USDC
              </dd>
            </div>
          </dl>
          <label className="studio-terms">
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              required={!insufficient && walletConnected}
            />{' '}
            I accept that platform holds this pool. Reviewed contributor impressions determine
            rewards; no single raider can earn more than 25% of the pool, with any excess going to
            other raiders. Unearned funds return to my balance. Delivery is not guaranteed.
          </label>
          <button
            className="button studio-launch"
            disabled={busy || !rate || !draft.targetPosts.some((p) => p.url.trim())}
            type="submit"
          >
            {busy
              ? 'Saving…'
              : !walletConnected
                ? 'Connect wallet'
                : insufficient
                  ? 'Deposit USDC'
                  : 'Fund & Launch Raid'}
          </button>
          {insufficient && (
            <p className="small-print">
              Add {formatUsdc(pool! - BigInt(available))} USDC to fund this Raid.
            </p>
          )}
          {message && (
            <p role={error ? 'alert' : 'status'} className={`message ${error ? 'error' : ''}`}>
              {message}
            </p>
          )}
        </aside>
      </form>
      <a className="studio-mobile-review button" href="#launch-summary">
        {pool !== null ? `${formatUsdc(pool)} USDC · ` : ''}Review & fund
      </a>
    </div>
  );
}
